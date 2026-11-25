import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { solveCaptcha } from './captcha-helper.mjs';

const origin = process.env.HWFORAI_DISCLOSURE_TEST_URL?.replace(/\/$/, '');
const mail = process.env.MAILPIT_URL?.replace(/\/$/, '');
const database = process.env.DATABASE_URL;
const onlyDisposable = origin && mail && database;
const suffix = randomUUID().replaceAll('-', '').slice(0, 9);
const fixturePassword = 'Disclosure-Representation-fixture-89!';

async function call(path, { method = 'GET', cookie, body, status = 200 } = {}) {
  const headers = {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
}

async function login(login, password = login) {
  const result = await call('/auth/login', { method: 'POST', body: { login, password } });
  assert.ok(result.cookie);
  return result;
}

async function registerObserver() {
  const username = 'exchange_observer_' + suffix;
  const email = username + '@example.test';
  const start = await call('/auth/register', { method: 'POST', status: 201, body: {
    username, email, password: fixturePassword, role: 'BUYER', captchaToken: await solveCaptcha(origin),
    participantType: 'INDIVIDUAL', country: 'RU', city: 'Пермь', telegram: username,
  } });
  const messages = await (await fetch(mail + '/api/v1/messages')).json();
  const letter = messages.messages.find(message => message.To.some(to => to.Address === email));
  assert.ok(letter, 'Mailpit captured the observer verification code');
  const detail = await (await fetch(mail + '/api/v1/message/' + letter.ID)).json();
  const code = detail.Text.match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  return call('/auth/verify', { method: 'POST', body: { challengeId: start.data.challengeId, code } });
}

test('disclosure journal, company confirmation and principal privacy', {
  skip: !onlyDisposable && 'Use a disposable demo with database access and Mailpit',
}, async () => {
  const db = new pg.Pool({ connectionString: database });
  try {
    const adminLogin = process.env.HWFORAI_DISCLOSURE_ADMIN_LOGIN || 'admin';
    const adminPassword = process.env.HWFORAI_DISCLOSURE_ADMIN_PASSWORD || 'admin';
    const admin = await login(adminLogin, adminPassword);
    if (admin.data.user.mustChangePassword) {
      const rotated = await call('/auth/credentials', { method: 'PATCH', cookie: admin.cookie,
        body: { currentPassword: adminPassword, newPassword: fixturePassword } });
      admin.cookie = rotated.cookie;
    }
    for (const [key, value] of [
      ['feature_invites', false], ['registration_mode', 'OPEN'], ['feature_disclosure_journal', true],
      ['feature_representation', true], ['feature_trust_rating', false], ['disclosure_min_level', 0],
    ]) {
      await call('/admin/settings/' + key, { method: 'PUT', body: { value }, cookie: admin.cookie });
    }

    const seller = await login('test1');
    const buyer = await login('test2');
    const observer = await registerObserver();
    await call('/auth/profile', { method: 'PATCH', cookie: seller.cookie, status: 400,
      body: { companyName: 'Северный Контур', displayName: 'severnyi_kontur_sales' } });
    await call('/me/representation', { method: 'PATCH', cookie: seller.cookie, body: { representationMode: 'AGENT' } });
    const fee = { disclosed: true, kind: 'PERCENT', value: 1.5, payer: 'SELLER' };
    await call('/me/agent-fee', { method: 'PUT', cookie: seller.cookie, body: fee });
    const privateNames = ['Harbor Rackworks ' + suffix, 'Secret Verifier ' + suffix];
    const privateAddress = 'desk-' + suffix + '@harbor.example';
    const principal = (await call('/me/principals', { method: 'POST', status: 201, cookie: seller.cookie,
      body: { name: privateNames[0], company: 'Internal Company ' + suffix } })).data;
    const category = (await call('/categories')).data.find(item => item.slug === 'gpu');
    const card = {
      kind: 'SELL', title: 'NVIDIA H100 SXM ' + suffix, description: 'Комплект для проверки скрытия реквизитов.',
      categoryId: category.id, quantity: 1, condition: 'NEW', availability: 'STOCK', stockCity: 'Москва', originCountry: 'RU',
      representation: 'AGENT', agentFeeDisclosed: true, agentFeeKind: 'PERCENT', agentFeeValue: 1.5, agentFeePayer: 'SELLER',
    };
    await call('/listings', { method: 'POST', cookie: seller.cookie, status: 400, body: card });
    const listing = (await call('/listings', { method: 'POST', cookie: seller.cookie, status: 201,
      body: { ...card, principalId: principal.id } })).data;
    assert.equal(listing.principal.id, principal.id);
    await call('/me/principals/' + principal.id, { method: 'DELETE', cookie: seller.cookie, status: 409 });
    await call('/me/principals/' + principal.id + '/email', { method: 'POST', cookie: seller.cookie, status: 400,
      body: { email: seller.data.user.email } });

    async function emailAction(email, expected, options = {}) {
      const letter = (await call('/me/principals/' + principal.id + '/email', { method: 'POST', status: 201,
        cookie: seller.cookie, body: { email } })).data.letter;
      const queued = (await db.query(`
        SELECT o.body,j.status FROM company_email_letters j JOIN exchange_email_outbox o ON o.id = j.outbox_id WHERE j.id=$1
      `, [letter.id])).rows[0];
      const url = queued.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(url);
      const path = '/actions/' + url;
      assert.equal((await call(path)).data.purpose, 'principal.confirm');
      assert.equal((await db.query('SELECT status FROM company_email_letters WHERE id=$1', [letter.id])).rows[0].status, 'SENT');
      await call(path, { method: 'POST', status: 400, body: { answer: 'YES' } });
      const answer = options.deny ? { answer: 'NO' } : { answer: 'YES', name: privateNames[1], feeAnswer: 'CONFIRMED' };
      const result = await call(path, { method: 'POST', body: answer });
      assert.equal(result.data.result, expected);
      await call(path, { method: 'POST', status: 409, body: answer });
    }
    await emailAction(privateAddress, 'CONFIRMED');
    const publicDetail = (await call('/listings/' + listing.id, { cookie: buyer.cookie })).data;
    assert.ok(publicDetail.labels.find(label => label.id === 'principal'));
    assert.ok(publicDetail.labels.find(label => label.id === 'fee' && label.tone === 'blue'));
    assert.equal(Object.hasOwn(publicDetail, 'principal'), false);
    await emailAction('desk-' + suffix + '@gmail.com', 'ACKNOWLEDGED');
    const queue = (await call('/admin/principals?status=PUBLIC_ACK', { cookie: admin.cookie })).data;
    assert.ok(queue.items.some(item => item.id === principal.id));
    await call('/admin/users/' + seller.data.user.id + '/principals/' + principal.id + '/confirm', {
      method: 'POST', status: 201, cookie: admin.cookie, body: { reason: 'Представительство проверено', feeConfirmed: true },
    });
    await emailAction(privateAddress, 'DECLINED', { deny: true });
    await call('/me/principals/' + principal.id + '/email', { method: 'POST', status: 429, cookie: seller.cookie, body: { email: privateAddress } });

    const chat = (await call('/chats', { method: 'POST', status: 201, cookie: buyer.cookie, body: { listingId: listing.id } })).data;
    assert.equal(chat.partner.companyName, null);
    const reveal = (cookie, body, status = 200) => call('/chats/' + chat.id + '/reveal', { cookie, method: 'PATCH', body, status });
    await reveal(buyer.cookie, { action: 'REQUEST' }, 400);
    const pending = (await reveal(buyer.cookie, { action: 'REQUEST', rulesAccepted: true })).data;
    const consent = { action: 'ACCEPT', requestId: pending.revealRequestId, rulesAccepted: true };
    await reveal(seller.cookie, { ...consent, rulesAccepted: false }, 400);
    const accepted = (await reveal(seller.cookie, consent)).data;
    const id = accepted.disclosure.id;
    assert.equal(accepted.disclosure.kind, 'FIRST');
    assert.equal(accepted.partner.companyName, buyer.data.user.companyName);
    await reveal(seller.cookie, consent, 409);
    await call('/disclosures/' + id, { cookie: observer.cookie, status: 404 });

    const surfaces = await Promise.all(['/listings', '/listings/' + listing.id, '/chats', '/chats/' + chat.id,
      '/disclosures/' + id, '/notifications'].map(path => call(path, { cookie: buyer.cookie })));
    for (const { data } of surfaces) {
      const body = JSON.stringify(data);
      for (const secret of [...privateNames, privateAddress, 'Internal Company ' + suffix]) assert.ok(!body.includes(secret), `Leaked ${secret}`);
    }
    for (const { data } of surfaces.slice(0, 2)) assert.ok(!JSON.stringify(data).includes(seller.data.user.companyName));
    assert.equal(surfaces[3].data.partner.companyName, seller.data.user.companyName);
    await call('/disclosures/' + id + '/already-known', { method: 'POST', status: 201, cookie: buyer.cookie });
    await call('/disclosures/' + id + '/already-known', { method: 'POST', status: 409, cookie: buyer.cookie });
    await call('/admin/disclosures/' + id + '/notes', { method: 'POST', status: 201, cookie: admin.cookie, body: { text: 'Служебная запись модератора' } });
    assert.ok(!(await call('/disclosures/' + id, { cookie: buyer.cookie })).data.events.some(event => event.type === 'ADMIN_NOTE'));
    await assert.rejects(db.query("UPDATE disclosures SET rules_version='9.0' WHERE id=$1", [id]), /не изменяется/);

    const profile = (await call('/auth/me', { cookie: seller.cookie })).data.user;
    await call('/auth/profile', { method: 'PATCH', cookie: seller.cookie, body: { telegram: 'renewed_' + suffix } });
    const stale = (await call('/chats/' + chat.id, { cookie: buyer.cookie })).data;
    assert.equal(stale.telegram, null);
    assert.equal(stale.telegramChanged.partner, true);
    assert.equal(stale.partner.companyName, profile.companyName);
    const next = (await reveal(buyer.cookie, { action: 'REQUEST', rulesAccepted: true })).data;
    const repeat = (await reveal(seller.cookie, { action: 'ACCEPT', requestId: next.revealRequestId, rulesAccepted: true })).data;
    assert.equal(repeat.disclosure.kind, 'REPEAT');
    await call('/disclosures/' + repeat.disclosure.id + '/already-known', { method: 'POST', status: 409, cookie: buyer.cookie });
  } finally {
    await db.end();
  }
});
