import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';

const apiUrl = process.env.HWFORAI_PRODUCTION_TEST_URL;
const appOrigin = process.env.APP_ORIGIN;
const mailpitUrl = process.env.MAILPIT_URL;
const adminLogin = process.env.BOOTSTRAP_ADMIN_USERNAME;
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

async function mailbox() {
  const response = await fetch(mailpitUrl + '/api/v1/messages');
  assert.ok(response.ok);
  return (await response.json()).messages;
}

async function codeFromMail(previousIds, email) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const message = (await mailbox()).find(item =>
      !previousIds.has(item.ID) && item.To.some(recipient => recipient.Address === email));
    if (message) {
      const response = await fetch(mailpitUrl + '/api/v1/message/' + message.ID);
      assert.ok(response.ok);
      const note = await response.json();
      assert.match(note.From.Address, /^no-reply@/i);
      const code = note.Text.match(/\b\d{6}\b/)?.[0];
      assert.ok(code);
      return code;
    }
    await setTimeout(100);
  }
  assert.fail('Mailpit did not receive a fresh staff verification code');
}

async function request(path, method, body, { origin = appOrigin, cookie } = {}) {
  return fetch(apiUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json', Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function beginSignIn(credentials, email = adminEmail) {
  const previousIds = new Set((await mailbox()).map(item => item.ID));
  const login = await request('/auth/login', 'POST', credentials);
  assert.equal(login.status, 200, await login.clone().text());
  assert.equal(login.headers.get('set-cookie'), null);
  const { challengeId } = await login.json();
  assert.ok(challengeId);
  return { challengeId, code: await codeFromMail(previousIds, email) };
}

async function signIn(credentials, email) {
  const verification = await beginSignIn(credentials, email);
  const wrongCode = verification.code === '000000' ? '000001' : '000000';
  const rejected = await request('/auth/verify', 'POST', { ...verification, code: wrongCode });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers.get('set-cookie'), null);
  const attempts = await Promise.all([1, 2].map(() => request('/auth/verify', 'POST', verification)));
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 400]);
  const verified = attempts.find(({ status }) => status === 200);
  assert.equal(verified.status, 200);
  const token = verified.headers.get('set-cookie');
  assert.ok(token);
  assert.match(token, /HttpOnly/);
  assert.match(token, /Secure/);
  assert.match(token, /SameSite=Lax/);
  return { cookie: token.split(';')[0], user: (await verified.json()).user };
}

test('production staff verify email over SMTP and rotate credentials with audit', async t => {
  assert.ok(apiUrl && appOrigin?.startsWith('https://') && mailpitUrl && adminLogin && adminEmail && adminPassword,
    'Set HWFORAI_PRODUCTION_TEST_URL, APP_ORIGIN, MAILPIT_URL and BOOTSTRAP_ADMIN_* for an isolated production-configured instance');
  assert.equal((await fetch(apiUrl + '/health')).status, 200);
  assert.equal((await request('/auth/login', 'POST', { login: 'admin', password: 'admin' })).status, 401);

  const credentials = { login: adminLogin, password: adminPassword };
  assert.equal((await request('/auth/login', 'POST', credentials, { origin: 'https://different.example.test' })).status, 403);

  const original = await signIn(credentials);
  assert.equal(original.user.mustChangePassword, true);
  const adminPage = (cookie) => fetch(apiUrl + '/admin/users', { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal((await adminPage()).status, 401);
  assert.equal((await adminPage(original.cookie)).status, 403);

  const staleCode = await beginSignIn(credentials);
  const rotate = (cookie, newPassword, username, currentPassword = adminPassword) => request('/auth/credentials', 'PATCH', {
    currentPassword, newPassword, username,
  }, { cookie });
  const invalidCurrent = await rotate(original.cookie, randomBytes(24).toString('hex'), undefined, 'incorrect-current');
  assert.equal(invalidCurrent.status, 401);
  assert.equal((await rotate(original.cookie, 'adminadminadmin')).status, 400);
  assert.equal((await adminPage(original.cookie)).status, 403);

  const candidates = [1, 2].map(() => ({ login: `qa-root-${randomBytes(5).toString('hex')}`, password: randomBytes(24).toString('hex') }));
  const rotations = await Promise.all(candidates.map(({ password, login }) => rotate(original.cookie, password, login)));
  assert.deepEqual(rotations.map(({ status }) => status).sort(), [200, 401]);
  const index = rotations.findIndex(({ status }) => status === 200);
  const winner = candidates[index];
  const { user: changed } = await rotations[index].json();
  assert.equal(changed.id, original.user.id);
  assert.equal(changed.username, winner.login);
  assert.equal(changed.mustChangePassword, false);
  assert.equal((await adminPage(original.cookie)).status, 401);
  assert.equal((await request('/auth/verify', 'POST', staleCode)).status, 401);
  assert.equal((await request('/auth/login', 'POST', credentials)).status, 401);
  assert.equal((await request('/auth/login', 'POST', candidates[1 - index])).status, 401);

  const renewed = await signIn(winner);
  assert.equal(renewed.user.username, winner.login);
  assert.equal(renewed.user.mustChangePassword, false);
  const adminResponse = await adminPage(renewed.cookie);
  assert.equal(adminResponse.status, 200);
  assert.match(adminResponse.headers.get('cache-control'), /no-store/);
  const users = (await adminResponse.json()).items;
  assert.deepEqual(users.filter(user => user.role === 'ADMIN').map(user => user.id), [renewed.user.id]);
  assert.ok(!('password_hash' in users[0]) && !('passwordHash' in users[0]) && !('credentialVersion' in users[0]));
  const audit = await fetch(apiUrl + '/admin/audit', { headers: { Cookie: renewed.cookie } });
  assert.equal(audit.status, 200);
  const credentialChanges = (await audit.json()).items.filter(({ action }) => action === 'credentials-changed');
  assert.equal(credentialChanges.length, 1);
  assert.equal(credentialChanges[0].actorUserId, renewed.user.id);
  assert.equal(credentialChanges[0].actor, original.user.username);
  assert.equal(credentialChanges[0].entityId, renewed.user.id);
  assert.equal(credentialChanges[0].before, null);
  assert.deepEqual(credentialChanges[0].after, { usernameChanged: true });

  await t.test('working registration opens only after policy publication', async () => {
    const guest = async () => fetch(apiUrl + '/auth/me').then(response => response.json());
    const before = await guest();
    assert.equal(before.pdRegistrationAvailable, false);
    const signup = await request('/auth/register', 'POST', {
      username: 'prod-policy-tester', email: 'prod-policy-tester@example.test',
      password: 'Production-policy-test-2026!', role: 'BUYER', participantType: 'INDIVIDUAL',
      city: 'Томск', country: 'RU', telegram: 'prod_policy_tester', captchaToken: 'not-solved',
      pdConsent: true, pdPolicyVersion: before.pdPolicyVersion,
    });
    assert.equal(signup.status, 503, await signup.text());
    const published = await request('/admin/settings/pd_policy_version', 'PUT', { value: '1.0' }, { cookie: renewed.cookie });
    assert.equal(published.status, 200, await published.text());
    assert.equal((await guest()).pdRegistrationAvailable, true);
  });

  await t.test('administrator provisions a moderator who must verify mail and rotate before moderation', async () => {
    const username = process.env.HWFORAI_PRODUCTION_MODERATOR_USERNAME || `qa-staff-${randomBytes(5).toString('hex')}`;
    const email = username + '@example.test';
    const temporaryPassword = randomBytes(24).toString('hex');
    const newPassword = process.env.HWFORAI_PRODUCTION_MODERATOR_PASSWORD || randomBytes(24).toString('hex');
    const response = await request('/admin/moderators', 'POST', {
      username, email, temporaryPassword, displayName: 'Модератор проверки',
    }, { cookie: renewed.cookie });
    assert.equal(response.status, 201, await response.clone().text());
    const { user: staff } = await response.json();
    assert.equal(staff.role, 'MODERATOR');
    assert.equal(staff.emailVerified, false);
    assert.equal(response.headers.get('set-cookie'), null);

    const activated = await signIn({ login: username, password: temporaryPassword }, email);
    assert.equal(activated.user.id, staff.id);
    assert.equal(activated.user.emailVerified, true);
    assert.equal(activated.user.mustChangePassword, true);
    assert.equal((await adminPage(activated.cookie)).status, 403);

    const rotated = await request('/auth/password', 'POST', {
      currentPassword: temporaryPassword, newPassword,
    }, { cookie: activated.cookie });
    assert.equal(rotated.status, 200);
    assert.equal((await rotated.json()).user.mustChangePassword, false);
    assert.equal((await adminPage(activated.cookie)).status, 401);
    const session = await signIn({ login: username, password: newPassword }, email);
    assert.equal(session.user.id, staff.id);
    assert.equal((await adminPage(session.cookie)).status, 200);
    const denied = await request('/admin/moderators', 'POST', {
      username, email, temporaryPassword, displayName: 'Недоступное действие',
    }, { cookie: session.cookie });
    assert.equal(denied.status, 403);
  });
});
