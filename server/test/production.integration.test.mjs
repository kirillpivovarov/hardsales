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

async function codeFromMail(previousIds) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const message = (await mailbox()).find(item =>
      !previousIds.has(item.ID) && item.To.some(recipient => recipient.Address === adminEmail));
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
  assert.fail('Mailpit did not receive a fresh administrator verification code');
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

async function signIn(credentials) {
  const previousIds = new Set((await mailbox()).map(item => item.ID));
  const login = await request('/auth/login', 'POST', credentials);
  assert.equal(login.status, 200, await login.clone().text());
  assert.equal(login.headers.get('set-cookie'), null);
  const { challengeId } = await login.json();
  assert.ok(challengeId);

  const verified = await request('/auth/verify', 'POST', { challengeId, code: await codeFromMail(previousIds) });
  assert.equal(verified.status, 200);
  const token = verified.headers.get('set-cookie');
  assert.ok(token);
  assert.match(token, /HttpOnly/);
  assert.match(token, /Secure/);
  assert.match(token, /SameSite=Lax/);
  return { cookie: token.split(';')[0], user: (await verified.json()).user };
}

test('production administrator signs in over SMTP, rotates credentials and unlocks administration', async () => {
  assert.ok(apiUrl && appOrigin?.startsWith('https://') && mailpitUrl && adminLogin && adminEmail && adminPassword,
    'Set HWFORAI_PRODUCTION_TEST_URL, APP_ORIGIN, MAILPIT_URL and BOOTSTRAP_ADMIN_* for an isolated production-configured instance');
  assert.equal((await fetch(apiUrl + '/health')).status, 200);
  assert.equal((await request('/auth/login', 'POST', { login: 'admin', password: 'admin' })).status, 401);

  const credentials = { login: adminLogin, password: adminPassword };
  assert.equal((await request('/auth/login', 'POST', credentials, { origin: 'https://different.example.test' })).status, 403);

  const original = await signIn(credentials);
  assert.equal(original.user.mustChangePassword, true);
  const adminPage = (cookie) => fetch(apiUrl + '/admin/users', { headers: { Cookie: cookie } });
  assert.equal((await adminPage(original.cookie)).status, 403);

  const nextLogin = `qa-root-${randomBytes(5).toString('hex')}`;
  const nextPassword = randomBytes(24).toString('hex');
  const rotation = await request('/auth/credentials', 'PATCH', {
    currentPassword: adminPassword, newPassword: nextPassword, username: nextLogin,
  }, { cookie: original.cookie });
  assert.equal(rotation.status, 200);
  assert.equal((await rotation.json()).user.mustChangePassword, false);
  assert.equal((await adminPage(original.cookie)).status, 401);
  assert.equal((await request('/auth/login', 'POST', credentials)).status, 401);

  const renewed = await signIn({ login: nextLogin, password: nextPassword });
  assert.equal(renewed.user.username, nextLogin);
  assert.equal(renewed.user.mustChangePassword, false);
  assert.equal((await adminPage(renewed.cookie)).status, 200);
});
