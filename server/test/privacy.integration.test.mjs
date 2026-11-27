import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import pg from 'pg';
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs';

const api = process.env.HWFORAI_PRIVACY_TEST_URL;
const mail = process.env.MAILPIT_URL;
const database = process.env.DATABASE_URL;
const password = 'Privacy regression test password 41!';
const template = {
  subject: 'Проверка представительства',
  body: 'Участник {agentNickname} указал доверителя. Подтверждение: {link}. Политика: {policyUrl}. Отказ: {optOutUrl}.',
};

async function call(path, { method = 'GET', body, cookie, status = 200, raw = false } = {}) {
  const response = await fetch(api + path, {
    method, headers: { 'User-Agent': 'privacy-regression/1.0', ...(cookie && { Cookie: cookie }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}

async function login(login, value = login) {
  const result = await call('/auth/login', { method: 'POST', body: { login, password: value } });
  assert.ok(result.cookie);
  return result;
}

async function codeFor(email) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(mail + '/api/v1/search?query=' + encodeURIComponent('to:' + email));
    assert.ok(response.ok);
    const mailbox = await response.json();
    const letter = (mailbox.messages ?? []).find(item => item.To.some(({ Address }) => Address === email));
    if (letter) {
      const detail = await fetch(mail + '/api/v1/message/' + letter.ID).then(result => result.json());
      const code = detail.Text.match(/\b\d{6}\b/)?.[0];
      if (code) return code;
    }
    await setTimeout(100);
  }
  assert.fail('Mailpit did not capture the registration code');
}

test('policy evidence, reacceptance, principal approval and opt-out, export, erasure', async t => {
  assert.ok(api && mail && database, 'Use a disposable fresh demo database and mail capture');
  const db = new pg.Pool({ connectionString: database });
  t.after(() => db.end());
  const suffix = randomBytes(5).toString('hex');
  const username = 'priv_' + suffix;
  const email = username + '@example.test';

  let admin = (await login('admin')).cookie;
  admin = (await call('/auth/credentials', {
    method: 'PATCH', cookie: admin, body: { currentPassword: 'admin', newPassword: password },
  })).cookie;
  const setting = (key, value, status) => call('/admin/settings/' + key, { method: 'PUT', cookie: admin, body: { value }, status });
  await setting('feature_invites', false);
  await setting('registration_mode', 'OPEN');
  await setting('feature_representation', true);
  const notice = (await db.query(`
    SELECT n.id,d.channel FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id=n.id
    JOIN users u ON u.id=n.user_id WHERE u.username='test2' AND n.kind='info.representation_enabled'
  `)).rows;
  assert.ok(notice.length > 0 && notice.every(row => row.channel !== 'EMAIL'));
  const guest = (await call('/auth/me')).data;
  assert.equal(guest.pdPolicyVersion, '0.1');
  assert.equal(guest.pdRegistrationAvailable, true);
  const body = {
    ...demoRegistrationConsent, username, email, password, city: 'Пермь', country: 'RU',
    role: 'BUYER', participantType: 'INDIVIDUAL', telegram: username, captchaToken: await solveCaptcha(api),
  };
  await call('/auth/register', { method: 'POST', status: 400, body: { ...body, pdConsent: undefined } });
  await call('/auth/register', { method: 'POST', status: 409, body: { ...body, pdPolicyVersion: '0.0' } });
  const pending = (await call('/auth/register', { method: 'POST', status: 201, body })).data;
  const saved = (await db.query('SELECT pending_registration FROM email_challenges WHERE id=$1', [pending.challengeId])).rows[0].pending_registration;
  const registration = await call('/auth/verify', { method: 'POST', body: { challengeId: pending.challengeId, code: await codeFor(email) } });
  const user = registration.data.user;
  const cookie = registration.cookie;
  assert.equal(user.pdConsentVersion, '0.1');
  assert.equal(user.pdConsentRequired, false);
  const evidence = (await call('/admin/users/' + user.id + '/consents', { cookie: admin })).data.items;
  assert.deepEqual(evidence.map(item => [item.kind, item.granted, item.source]), [
    ['INFO_EMAIL', false, 'REGISTRATION'], ['PD_PROCESSING', true, 'REGISTRATION'],
  ]);
  assert.ok(evidence.every(item => item.ip && item.userAgent === 'privacy-regression/1.0' && item.givenAt === saved.pdConsentAt));
  await assert.rejects(db.query('UPDATE user_consents SET granted=false WHERE user_id=$1', [user.id]),
    /Запись о согласии не изменяется/);

  const seller = (await login('test1')).cookie;
  await call('/me/representation', { method: 'PATCH', cookie: seller, body: { representationMode: 'AGENT' } });
  const principal = (await call('/me/principals', {
    method: 'POST', cookie: seller, status: 201, body: { name: 'Рабочая компания' },
  })).data;
  const recipient = 'desk-' + suffix + '@example-company.test';
  const send = status => call('/me/principals/' + principal.id + '/email', {
    method: 'POST', cookie: seller, status, body: { email: recipient },
  });
  await send(409);
  await setting('third_party_letter', { ...template, approved: true, body: template.body.replace('{optOutUrl}', '') }, 400);
  assert.equal((await setting('third_party_letter', { ...template, approved: true })).data.value.approved, true);
  const letter = (await send(201)).data.letter;
  const queued = (await db.query(`
    SELECT o.body FROM company_email_letters c JOIN exchange_email_outbox o ON o.id=c.outbox_id WHERE c.id=$1
  `, [letter.id])).rows[0].body;
  assert.match(queued, /\/info\/pd_policy/);
  const answers = [...queued.matchAll(/\/a\/([A-Za-z0-9_-]{43})/g)].map(match => match[1]);
  assert.equal(answers.length, 2);
  const optOut = '/actions/' + answers[1];
  assert.equal((await call(optOut)).data.purpose, 'email.optout');
  await call(optOut, { method: 'POST', body: {} });
  assert.equal((await db.query("SELECT count(*)::int AS count FROM email_suppressions WHERE reason='RECIPIENT_OPT_OUT'")).rows[0].count, 1);
  assert.deepEqual((await call('/admin/email-suppressions/count', { cookie: admin })).data, { count: 1 });
  assert.equal((await db.query('SELECT status FROM company_email_letters WHERE id=$1', [letter.id])).rows[0].status, 'EXPIRED');
  await send(409);
  assert.equal((await setting('third_party_letter', { ...template, approved: true, subject: template.subject + ' и запрос' })).data.value.approved, false);

  await setting('feature_disclosure_journal', true);
  await setting('feature_trust_rating', true);
  const { rows: [offer] } = await db.query(`
    SELECT l.id FROM listings l JOIN users u ON u.id=l.owner_id
    WHERE u.username='test1' AND l.kind='SELL' AND l.status='ACTIVE' LIMIT 1
  `);
  const chat = (await call('/chats', { method: 'POST', cookie, status: 201, body: { listingId: offer.id } })).data;
  const revealPath = '/chats/' + chat.id + '/reveal';
  const asked = (await call(revealPath, { method: 'PATCH', cookie, body: { action: 'REQUEST', rulesAccepted: true } })).data;
  const disclosure = (await call(revealPath, {
    method: 'PATCH', cookie: seller, body: { action: 'ACCEPT', rulesAccepted: true, requestId: asked.revealRequestId },
  })).data.disclosure;
  await call('/chats/' + chat.id + '/messages', {
    method: 'POST', cookie, status: 201, body: { body: 'Запись переписки остаётся у собеседника' },
  });
  const original = (await db.query('SELECT party_a,party_b FROM disclosures WHERE id=$1', [disclosure.id])).rows[0];
  const deal = (await db.query('SELECT id FROM deals WHERE disclosure_id=$1', [disclosure.id])).rows[0];
  await db.query(`
    INSERT INTO verification_documents(user_id,deal_id,kind,file_name,mime_type,content,sha256) VALUES
      ($1,$2,'DEAL_DOC','deal.pdf','application/pdf',decode('018abc','hex'),repeat('0',64)),
      ($1,NULL,'COMPANY_CARD','personal.pdf','application/pdf',decode('029def','hex'),repeat('0',64))
  `, [user.id, deal.id]);

  await setting('pd_policy_version', '1.1');
  assert.equal((await call('/auth/me', { cookie })).data.pdConsentRequired, true);
  await call('/listings', { cookie });
  const blocked = await call('/auth/profile', { method: 'PATCH', cookie, status: 403, body: { city: 'Самара' } });
  assert.equal(blocked.data.code, 'PD_CONSENT_REQUIRED');
  await call('/auth/consent', { method: 'POST', cookie, status: 409, body: { pdPolicyVersion: '0.1' } });
  const requestPath = '/me/data-requests';
  const exportRequest = (await call(requestPath, { method: 'POST', cookie, status: 201, body: { kind: 'EXPORT' } })).data;
  await call(requestPath, { method: 'POST', cookie, status: 409, body: { kind: 'EXPORT' } });
  const consent = await call('/auth/consent', { method: 'POST', cookie, body: { pdPolicyVersion: '1.1' } });
  assert.equal(consent.data.user.pdConsentRequired, false);
  const updated = await call('/auth/profile', { method: 'PATCH', cookie, body: { infoEmailConsent: true } });
  assert.equal(updated.data.user.infoEmailConsent, true);
  const categoryId = (await call('/categories')).data.find(category => category.slug === 'gpu').id;
  const ownListing = (await call('/listings', { method: 'POST', cookie, status: 201, body: {
    kind: 'BUY', title: 'Заявка для проверки выгрузки', description: 'Нужен ускоритель с поставкой по договорённости.',
    categoryId, modelId: 'h100-sxm', quantity: 1, destinationCountry: 'RU', originScope: 'ANY',
    deliveryBy: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  } })).data;
  await call('/admin/data-requests/' + exportRequest.id + '/export', { method: 'POST', cookie: admin, status: 201 });
  const downloadPath = requestPath + '/' + exportRequest.id + '/export';
  await call(downloadPath, { cookie: seller, status: 404 });
  await call(downloadPath, { cookie: admin, status: 403 });
  const file = await call(downloadPath, { cookie, raw: true });
  assert.match(file.headers.get('content-type'), /application\/gzip/);
  assert.match(file.headers.get('cache-control'), /no-store/);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  const contents = gunzipSync(file.data).toString();
  const exported = JSON.parse(contents);
  assert.equal(exported.profile.username, username);
  const listingData = exported.listings.find(listing => listing.id === ownListing.id);
  assert.ok(listingData);
  assert.ok(!Object.hasOwn(listingData, 'duplicate_of') && !Object.hasOwn(listingData, 'lot_key'));
  assert.deepEqual(exported.documents.map(item => item.fileName).sort(), ['deal.pdf', 'personal.pdf']);
  assert.ok(exported.documents.every(item => !Object.hasOwn(item, 'content')));
  assert.ok(exported.disclosures.some(item => item.id === disclosure.id));
  assert.ok(exported.messages.some(item => item.chat_id === chat.id));
  assert.doesNotMatch(contents, /password_hash|privacy-regression\/1\.0|"ip"/);
  await db.query("UPDATE data_requests SET export_expires_at=now()-interval '1 hour' WHERE id=$1", [exportRequest.id]);
  await call(downloadPath, { cookie, status: 410 });

  const deletion = (await call(requestPath, { method: 'POST', cookie, status: 201, body: { kind: 'DELETE' } })).data;
  const deletePath = '/admin/data-requests/' + deletion.id + '/delete';
  await call(deletePath, { method: 'POST', cookie: admin, status: 400, body: { confirm: false } });
  const erased = (await call(deletePath, { method: 'POST', cookie: admin, status: 201, body: { confirm: true } })).data;
  assert.ok(erased.retained.length >= 2);
  await call(deletePath, { method: 'POST', cookie: admin, status: 409, body: { confirm: true } });
  assert.equal((await call('/auth/me', { cookie })).data.user, null);
  await call('/auth/login', { method: 'POST', status: 401, body: { login: username, password } });
  const profile = (await db.query('SELECT username,email,telegram,status,deleted_at FROM users WHERE id=$1', [user.id])).rows[0];
  assert.match(profile.username, /^deleted-/);
  assert.notEqual(profile.email, email);
  assert.notEqual(profile.telegram, username);
  assert.equal(profile.status, 'BANNED');
  assert.ok(profile.deleted_at);
  assert.deepEqual((await db.query('SELECT party_a,party_b FROM disclosures WHERE id=$1', [disclosure.id])).rows[0], original);
  assert.deepEqual((await db.query('SELECT file_name FROM verification_documents WHERE user_id=$1', [user.id])).rows,
    [{ file_name: 'deal.pdf' }]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_messages WHERE chat_id=$1 AND sender_id=$2',
    [chat.id, user.id])).rows[0].count, 1);
  const retainedChat = (await call('/chats/' + chat.id, { cookie: seller })).data;
  assert.equal(retainedChat.partner.nickname, 'Удалённый участник');
  assert.equal(retainedChat.telegram, null);
  const retainedHistory = (await call('/chats/' + chat.id + '/messages', { cookie: seller })).data;
  assert.ok(retainedHistory.some(item => item.body === 'Запись переписки остаётся у собеседника'));
  const audit = await db.query("SELECT action FROM moderation_audit WHERE entity='data_requests' AND entity_id IN ($1,$2)", [exportRequest.id, deletion.id]);
  assert.deepEqual(new Set(audit.rows.map(row => row.action)), new Set(['requested', 'export_built', 'export_downloaded', 'deleted']));
});
