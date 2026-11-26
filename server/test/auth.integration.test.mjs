import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs';

const api = process.env.HWFORAI_AUTH_TEST_URL;
const mailpit = process.env.MAILPIT_URL;
const databaseUrl = process.env.DATABASE_URL;

async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json(),
    setCookie: response.headers.get('set-cookie'),
  };
}

async function emailCode(email, excluded = []) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const inbox = await mailbox(email);
    const message = inbox.find((entry) =>
      !excluded.includes(entry.ID) && entry.To.some(({ Address }) => Address === email),
    );
    if (message) {
      const detail = await fetch(`${mailpit}/api/v1/message/${message.ID}`).then((response) => response.json());
      const code = detail.Text.match(/\b\d{6}\b/)?.[0];
      assert.ok(code, 'Mailpit returned a six-digit code');
      assert.match(detail.From.Address, /^no-reply@/);
      return { id: message.ID, code };
    }
    await setTimeout(100);
  }
  assert.fail('Email did not arrive in Mailpit within five seconds');
}

async function mailbox(email) {
  const search = new URLSearchParams({ query: `to:${email}` });
  const response = await fetch(`${mailpit}/api/v1/search?${search}`);
  assert.ok(response.ok);
  return (await response.json()).messages ?? [];
}

test('registration, SMTP verification, session revocation and admin bootstrap gate', async (t) => {
  assert.ok(api && mailpit && databaseUrl, 'Set HWFORAI_AUTH_TEST_URL, MAILPIT_URL and DATABASE_URL for an isolated demo instance');
  const db = new pg.Pool({ connectionString: databaseUrl });
  const username = `qa-${randomBytes(5).toString('hex')}`;
  const email = `${username}@example.test`;
  t.after(async () => {
    try {
      await db.query('DELETE FROM email_challenges WHERE email = $1', [email]);
    } finally {
      await db.end();
    }
  });

  assert.deepEqual((await request('/health')).data, { status: 'ok' });
  const guest = (await request('/auth/me')).data;
  assert.equal(guest.user, null);
  assert.equal(guest.pdPolicyVersion, demoRegistrationConsent.pdPolicyVersion);
  assert.equal(guest.pdRegistrationAvailable, true);

  const adminLogin = await request('/auth/login', {
    method: 'POST', body: { login: 'admin', password: 'admin' },
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.user.role, 'ADMIN');
  assert.equal(adminLogin.data.user.mustChangePassword, true);
  const adminCookie = adminLogin.setCookie.split(';')[0];
  assert.equal((await request('/auth/profile', {
    method: 'PATCH', cookie: adminCookie, body: { displayName: 'Администратор QA' },
  })).status, 403);
  await request('/auth/logout', { method: 'POST', cookie: adminCookie });

  const localLogin = await request('/auth/login', {
    method: 'POST', body: { login: 'test1', password: 'test1' }, headers: { Origin: 'https://different.example.test' },
  });
  assert.equal(localLogin.status, 403);
  for (const [login, role] of [['test1', 'SELLER'], ['test2', 'BUYER']]) {
    const demo = await request('/auth/login', { method: 'POST', body: { login, password: login } });
    assert.equal(demo.status, 200);
    assert.equal(demo.data.user.role, role);
    assert.equal(demo.data.user.emailVerified, true);
    await request('/auth/logout', { method: 'POST', cookie: demo.setCookie.split(';')[0] });
  }

  const password = 'Test account password 41!';
  const registration = {
    ...demoRegistrationConsent,
    username, email, password, role: 'BUYER', participantType: 'COMPANY', city: 'Пермь',
    country: 'ru', telegram: '@example_check',
  };
  const incomplete = await request('/auth/register', { method: 'POST', body: registration });
  assert.equal(incomplete.status, 400);
  for (const fields of [{ city: 'Пермь +7 (900) 123-45-67' }, { companyName: 'Компания\0QA' }]) {
    const invalid = await request('/auth/register', {
      method: 'POST', body: { ...registration, captchaToken: 'placeholder', companyName: 'Тестовая компания', ...fields },
    });
    assert.equal(invalid.status, 400);
  }
  const valid = { ...registration, companyName: 'Тестовая компания' };
  for (const candidate of [valid, { ...valid, captchaToken: 'invalid' }]) {
    assert.equal((await request('/auth/register', { method: 'POST', body: candidate })).status, 400);
  }
  assert.deepEqual(await mailbox(email), []);
  const captchaToken = await solveCaptcha(api);
  const submit = (token) => request('/auth/register', { method: 'POST', body: { ...valid, captchaToken: token } });
  const signup = await submit(captchaToken);
  assert.equal(signup.status, 201);
  assert.deepEqual(Object.keys(signup.data).sort(), ['challengeId', 'email', 'expiresIn']);
  assert.equal(signup.data.expiresIn, 600);
  assert.equal(signup.setCookie, null);
  assert.equal((await submit(captchaToken.replace(/=+$/, '') + ' ')).status, 429);
  assert.equal((await request('/auth/login', { method: 'POST', body: { login: username, password } })).status, 401);

  const initial = await emailCode(email);
  const earlyResend = await request('/auth/resend', { method: 'POST', body: { challengeId: signup.data.challengeId } });
  assert.equal(earlyResend.status, 429);
  await db.query("UPDATE email_challenges SET resend_at = now() - interval '1 second' WHERE id = $1", [signup.data.challengeId]);
  const resent = await request('/auth/resend', { method: 'POST', body: { challengeId: signup.data.challengeId } });
  assert.equal(resent.status, 200);
  assert.notEqual(resent.data.challengeId, signup.data.challengeId);
  const updated = await emailCode(email, [initial.id]);

  const verify = (challengeId, code) => request('/auth/verify', { method: 'POST', body: { challengeId, code } });
  assert.equal((await verify(signup.data.challengeId, initial.code)).status, 400);
  const wrongCode = updated.code === '000000' ? '000001' : '000000';
  assert.equal((await verify(resent.data.challengeId, wrongCode)).status, 400);
  const attempts = await Promise.all([verify(resent.data.challengeId, updated.code), verify(resent.data.challengeId, updated.code)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 400]);
  const verified = attempts.find(({ status }) => status === 200);
  assert.match(verified.setCookie, /HttpOnly/i);
  assert.match(verified.setCookie, /SameSite=Lax/i);
  assert.equal(verified.data.user.emailVerified, true);
  assert.equal(verified.data.user.country, 'RU');
  assert.equal(verified.data.user.telegram, 'example_check');
  assert.equal(verified.data.user.role, 'BUYER');
  const oldCookie = verified.setCookie.split(';')[0];
  assert.equal((await request('/auth/me', { cookie: oldCookie })).data.user.id, verified.data.user.id);

  for (const displayName of ['Chat https://t.me/other', 'tg://user?id=123456', 'www.example.com', 'Компания\0QA']) {
    const misleadingName = await request('/auth/profile', {
      method: 'PATCH', cookie: oldCookie, body: { displayName },
    });
    assert.equal(misleadingName.status, 400);
  }
  const changedProfile = await request('/auth/profile', {
    method: 'PATCH', cookie: oldCookie, body: { displayName: 'Компания QA', city: 'Самара' },
  });
  assert.equal(changedProfile.status, 200);
  assert.equal(changedProfile.data.user.city, 'Самара');

  const login = (value) => request('/auth/login', { method: 'POST', body: { login: email, password: value } });
  const pending = await login(password);
  assert.equal(pending.status, 200);
  assert.equal(pending.setCookie, null);
  const loginMessage = await emailCode(email, [initial.id, updated.id]);

  const newPassword = 'Test account password 52!';
  const changed = await request('/auth/password', {
    method: 'POST', cookie: oldCookie, body: { currentPassword: password, newPassword },
  });
  assert.equal(changed.status, 200);
  const freshCookie = changed.setCookie.split(';')[0];
  assert.notEqual(freshCookie, oldCookie);
  assert.equal((await request('/auth/me', { cookie: oldCookie })).data.user, null);
  assert.equal((await verify(pending.data.challengeId, loginMessage.code)).status, 401);
  assert.equal((await login(password)).status, 401);

  const renewedLogin = await login(newPassword);
  const renewedMessage = await emailCode(email, [initial.id, updated.id, loginMessage.id]);
  const renewed = await verify(renewedLogin.data.challengeId, renewedMessage.code);
  assert.equal(renewed.status, 200);
  const renewedCookie = renewed.setCookie.split(';')[0];
  assert.equal((await request('/auth/logout', { method: 'POST', cookie: renewedCookie })).status, 204);
  assert.equal((await request('/auth/me', { cookie: renewedCookie })).data.user, null);
  await request('/auth/logout', { method: 'POST', cookie: freshCookie });

  const lockedLogin = await login(newPassword);
  assert.equal(lockedLogin.status, 200);
  const lockedMessage = await emailCode(email, [initial.id, updated.id, loginMessage.id, renewedMessage.id]);
  const inaccurate = lockedMessage.code === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await verify(lockedLogin.data.challengeId, inaccurate)).status, 400);
  }
  assert.equal((await verify(lockedLogin.data.challengeId, lockedMessage.code)).status, 400);
});

test('registration races cannot reserve or duplicate account identifiers', async (t) => {
  const db = new pg.Pool({ connectionString: databaseUrl });
  const username = `qa-${randomBytes(5).toString('hex')}`;
  const addresses = ['first', 'second', 'third'].map(suffix => `${username}-${suffix}@example.test`);
  t.after(async () => {
    try {
      await db.query('DELETE FROM email_challenges WHERE email = ANY($1::text[])', [addresses]);
    } finally {
      await db.end();
    }
  });

  const password = 'Registration test password 76!';
  const telegram = 'example_check';
  const registration = {
    ...demoRegistrationConsent,
    username, password, telegram,
    role: 'SELLER', participantType: 'INDIVIDUAL', city: 'Томск', country: 'RU',
  };
  const signup = async (email, login) => request('/auth/register', {
    method: 'POST', body: { ...registration, email, username: login, captchaToken: await solveCaptcha(api) },
  });
  const verify = (challengeId, code) => request('/auth/verify', { method: 'POST', body: { challengeId, code } });
  const [first, second, third] = addresses;
  const sameMailbox = await Promise.all([signup(first, username), signup(first.toUpperCase(), username)]);
  assert.deepEqual(sameMailbox.map(response => response.status).sort(), [201, 429]);
  assert.equal((await mailbox(first)).length, 1);
  assert.equal((await db.query('SELECT id FROM users WHERE lower(username) = $1', [username])).rowCount, 0);

  const otherMailbox = await signup(second, username.toUpperCase());
  assert.equal(otherMailbox.status, 201);
  const codes = await Promise.all([emailCode(first), emailCode(second)]);
  const challenges = [sameMailbox.find(response => response.status === 201), otherMailbox];
  const completions = await Promise.all(challenges.map((response, index) =>
    verify(response.data.challengeId, codes[index].code),
  ));
  assert.deepEqual(completions.map(response => response.status).sort(), [200, 409]);
  const winner = completions.find(response => response.status === 200).data.user;
  const duplicate = await signup(winner.email.toUpperCase(), `${username}-another`);
  assert.equal(duplicate.status, 201);
  assert.ok(duplicate.data.challengeId);
  assert.equal(duplicate.setCookie, null);
  assert.equal((await mailbox(winner.email)).length, 1, 'Duplicate email did not receive another email');
  assert.equal((await verify(duplicate.data.challengeId, codes[addresses.indexOf(winner.email)].code)).status, 400);

  const independent = await signup(third, `${username}-third`);
  assert.equal(independent.status, 201);
  const thirdCode = await emailCode(third);
  const thirdUser = await verify(independent.data.challengeId, thirdCode.code);
  assert.equal(thirdUser.status, 200);
  assert.equal(thirdUser.data.user.telegram, winner.telegram);
  const profile = await request('/auth/profile', {
    method: 'PATCH', cookie: thirdUser.setCookie.split(';')[0], body: { displayName: winner.displayName },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.user.displayName, winner.displayName);

  const login = await request('/auth/login', {
    method: 'POST', body: { login: winner.username.toUpperCase(), password },
  });
  assert.equal(login.status, 200);
  const loginCode = await emailCode(winner.email, [codes[addresses.indexOf(winner.email)].id]);
  await db.query("UPDATE email_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [login.data.challengeId]);
  assert.equal((await verify(login.data.challengeId, loginCode.code)).status, 400);
});
