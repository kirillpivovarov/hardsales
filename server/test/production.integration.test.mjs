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

async function beginSignIn(credentials) {
  const previousIds = new Set((await mailbox()).map(item => item.ID));
  const login = await request('/auth/login', 'POST', credentials);
  assert.equal(login.status, 200, await login.clone().text());
  assert.equal(login.headers.get('set-cookie'), null);
  const { challengeId } = await login.json();
  assert.ok(challengeId);
  return { challengeId, code: await codeFromMail(previousIds) };
}

async function signIn(credentials) {
  const verification = await beginSignIn(credentials);
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

test('production administrator signs in over SMTP and rotates credentials atomically with audit', async () => {
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
});
