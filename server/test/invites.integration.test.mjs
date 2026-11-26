import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs';

const api = process.env.HWFORAI_INVITES_TEST_URL?.replace(/\/$/, '');
const mailpit = process.env.MAILPIT_URL?.replace(/\/$/, '');
const database = process.env.DATABASE_URL;

async function request(path, { method = 'GET', body, cookie, status } = {}) {
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (status !== undefined) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return { data, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function emailCode(email) {
  const response = await fetch(mailpit + '/api/v1/messages');
  assert.ok(response.ok);
  const mailbox = await response.json();
  const message = mailbox.messages.find((item) => item.To.some((to) => to.Address === email));
  assert.ok(message, 'Mailpit received the challenge for the generated fixture');
  const detail = await fetch(mailpit + '/api/v1/message/' + message.ID).then((result) => result.json());
  const code = detail.Text.match(/\b\d{6}\b/)?.[0];
  assert.ok(code, 'The signup email contains a six-digit code');
  return code;
}

test('invite concurrency, questionnaire and rules gate', {
  skip: !(api && mailpit && database) && 'Requires a fresh isolated demo database, app and Mailpit',
}, async (t) => {
  const db = new pg.Pool({ connectionString: database });
  t.after(() => db.end());
  const id = randomBytes(5).toString('hex');
  const password = randomBytes(18).toString('base64url');

  const guest = (await request('/auth/me')).data;
  assert.equal(guest.user, null);
  assert.equal(guest.pdPolicyVersion, demoRegistrationConsent.pdPolicyVersion);
  const initial = await request('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin' }, status: 200 });
  const { cookie: admin } = await request('/auth/credentials', {
    method: 'PATCH', cookie: initial.cookie, body: { currentPassword: 'admin', newPassword: password }, status: 200,
  });
  const setting = (key, value) => request('/admin/settings/' + key, {
    method: 'PUT', cookie: admin, body: { value }, status: 200,
  });
  await setting('feature_invites', true);
  await setting('registration_mode', 'INVITE');
  assert.equal((await request('/auth/me')).data.registrationMode, 'INVITE');

  const { data: { items: [invite, revoked] } } = await request('/admin/invites', {
    method: 'POST', cookie: admin, body: { count: 2, note: 'Проверка приглашений', presetRole: 'BUYER' }, status: 201,
  });
  assert.match(invite.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const register = async (name, inviteCode, role = 'BUYER') => {
    const username = name + id;
    const email = username + '@example.test';
    const result = await request('/auth/register', { method: 'POST', body: {
      ...demoRegistrationConsent,
      username, email, password, role, participantType: 'INDIVIDUAL', city: 'Омск', country: 'RU',
      telegram: username, captchaToken: await solveCaptcha(api), ...(inviteCode === undefined ? {} : { inviteCode }),
    } });
    return { ...result, email };
  };
  const missing = await register('missing', undefined);
  assert.equal(missing.status, 400);
  assert.equal(missing.data.message, 'Код приглашения не найден или уже использован');
  const otherRole = await register('wrongrole', invite.code, 'SELLER');
  assert.equal(otherRole.status, 400);
  assert.equal(otherRole.data.message, 'Приглашение выдано для другой роли');

  const candidates = [
    await register('first', ' ' + invite.code.toLowerCase().replace('-', ' ') + ' '),
    await register('second', invite.code),
  ];
  assert.ok(candidates.every(({ status }) => status === 201));
  const confirm = async ({ data, email }) => request('/auth/verify', {
    method: 'POST', body: { challengeId: data.challengeId, code: await emailCode(email) },
  });
  const raced = await Promise.all(candidates.map(confirm));
  assert.deepEqual(raced.map(({ status }) => status).sort(), [200, 409]);
  const { cookie, data: { user } } = raced.find(({ status }) => status === 200);
  assert.equal(user.onboardingState, 'REQUIRED');
  assert.deepEqual((await db.query('SELECT id FROM users WHERE invite_id = $1', [invite.id])).rows, [{ id: user.id }]);
  assert.equal((await db.query('SELECT used_by FROM invites WHERE id = $1', [invite.id])).rows[0].used_by, user.id);
  assert.equal((await register('used', invite.code)).data.message, missing.data.message);

  const waiting = await register('revocation', revoked.code);
  assert.equal(waiting.status, 201);
  await request('/admin/invites/' + revoked.id + '/revoke', {
    method: 'PATCH', cookie: admin, body: { reason: 'Проверка отзыва приглашения' }, status: 200,
  });
  assert.equal((await confirm(waiting)).status, 409);
  assert.equal((await db.query('SELECT used_by FROM invites WHERE id = $1', [revoked.id])).rows[0].used_by, null);

  const { data: listings } = await request('/listings', { cookie, status: 200 });
  assert.ok(listings.items.length > 0);
  await request('/chats', { method: 'POST', cookie, body: { listingId: listings.items[0].id }, status: 403 });
  const { data: categories } = await request('/categories', { status: 200 });
  const listing = {
    categoryId: categories.find(({ slug }) => slug === 'gpu').id,
    title: 'Тестовая заявка на ускорители ' + id,
    description: 'Заявка создана для проверки допуска после анкеты.',
    destinationCountry: 'RU',
    deliveryBy: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
  };
  await request('/listings', { method: 'POST', cookie, body: listing, status: 403 });

  const { data: questionnaire } = await request('/onboarding', { cookie, status: 200 });
  assert.deepEqual(questionnaire.groups[0].questions.filter(({ required }) => required).map(({ id: key }) => key),
    ['buyer_02', 'buyer_03', 'buyer_06']);
  const answers = {
    buyer_02: 'Закупки для собственной инфраструктуры',
    buyer_03: 'Две карты вычислительного ускорителя',
    buyer_06: 'Оплата по счёту',
    buyer_01: '   ',
  };
  const body = { representationMode: 'AGENT', answers, rulesVersion: questionnaire.rulesVersion,
    principal: { name: 'Тестовый принципал', company: 'Тестовая компания' } };
  await request('/onboarding', { method: 'PUT', cookie, body: { ...body, answers: { ...answers, buyer_02: '' } }, status: 400 });
  await request('/onboarding', { method: 'PUT', cookie, body: { ...body, answers: { ...answers, buyer_02: 'https://example.test' } }, status: 400 });
  const { data: { user: updated } } = await request('/onboarding', { method: 'PUT', cookie, body, status: 200 });
  assert.equal(updated.onboardingState, 'DONE');
  assert.equal(updated.representationMode, 'AGENT');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM user_principals WHERE user_id = $1', [user.id])).rows[0].count, 1);
  const { data: record } = await request('/admin/users/' + user.id + '/onboarding', { cookie: admin, status: 200 });
  assert.equal(record.answers.buyer_01, undefined);
  const { data: created } = await request('/listings', { method: 'POST', cookie, body: listing, status: 201 });

  await setting('rules_version', '1.1');
  const path = '/listings/' + created.id;
  const edit = { title: listing.title + ' — обновление' };
  const stale = await request(path, { method: 'PATCH', cookie, body: edit, status: 409 });
  assert.equal(stale.data.code, 'RULES_NOT_ACCEPTED');
  await request('/auth/rules/accept', { method: 'POST', cookie, body: { rulesVersion: '1.1' }, status: 200 });
  await request(path, { method: 'PATCH', cookie, body: edit, status: 200 });
  const notices = (await db.query("SELECT kind FROM notifications WHERE kind IN ('onboarding.submitted','invite.used')")).rows;
  assert.deepEqual(notices.map(({ kind }) => kind).sort(), ['invite.used', 'onboarding.submitted']);
});
