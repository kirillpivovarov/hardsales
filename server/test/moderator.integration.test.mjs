import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import { solveCaptcha } from './captcha-helper.mjs';

const origin = process.env.HWFORAI_MODERATOR_TEST_URL?.replace(/\/$/, '');
const mailOrigin = process.env.MAILPIT_URL?.replace(/\/$/, '');
const agentToken = process.env.MODERATION_AGENT_TOKEN;
const tag = randomBytes(4).toString('hex');
const temporaryPassword = 'New-Staff-fixture-' + tag;
const permanentPassword = 'Local-Staff-secret-' + tag;
const reason = 'Регрессионная проверка полномочий модератора.';

async function api(path, { method = 'GET', cookie, body, status = 200, headers = {} } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined || multipart ? body : JSON.stringify(body),
  });
  assert.equal(response.status, status, method + ' ' + path + ': ' + await response.clone().text());
  return {
    data: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null,
  };
}

async function inbox() {
  const response = await fetch(mailOrigin + '/api/v1/messages');
  assert.ok(response.ok, 'Mailpit inbox is reachable');
  return (await response.json()).messages;
}

async function loginChallenge(login, password, email) {
  const previous = new Set((await inbox()).map(item => item.ID));
  const { data, cookie } = await api('/auth/login', { method: 'POST', body: { login, password } });
  assert.equal(cookie, null, 'The password alone must not provide a staff session');
  assert.notEqual(data.email, email);
  assert.ok(data.email.includes('*') && data.email.endsWith('@example.test'));
  assert.ok(data.challengeId);
  for (let attempt = 0; attempt < 60; attempt++) {
    const message = (await inbox()).find(item => !previous.has(item.ID) &&
      item.To.some(recipient => recipient.Address === email));
    if (message) {
      const item = await fetch(mailOrigin + '/api/v1/message/' + message.ID).then(response => response.json());
      assert.match(item.From.Address, /^no-reply@/i);
      const code = item.Text.match(/\b\d{6}\b/)?.[0];
      assert.ok(code, 'The message has a six-digit code');
      return { challengeId: data.challengeId, code };
    }
    await setTimeout(100);
  }
  assert.fail('No fresh staff authentication email');
}

function verify(body, status = 200) {
  return api('/auth/verify', { method: 'POST', body, status });
}

function status(path, cookie, next, expected = 200) {
  return api('/admin/' + path + '/status', {
    method: 'PATCH', cookie, body: { status: next, reason }, status: expected,
  });
}

test('moderator authentication, contextual resources, role boundaries and audit', async t => {
  assert.ok(origin && mailOrigin && agentToken,
    'Set HWFORAI_MODERATOR_TEST_URL, MAILPIT_URL and MODERATION_AGENT_TOKEN for an isolated seeded demo');
  const demo = login => api('/auth/login', { method: 'POST', body: { login, password: login } });
  let admin = await demo('admin');
  if (admin.data.user.mustChangePassword) {
    admin = await api('/auth/credentials', {
      method: 'PATCH', cookie: admin.cookie,
      body: { currentPassword: 'admin', newPassword: 'Moderation-QA-owner-C8-' + tag },
    });
  }
  const seller = await demo('test1');
  const buyer = await demo('test2');
  const { id: adminId } = admin.data.user;
  const moderatorAccount = {
    username: 'staff-' + tag, displayName: 'Модератор проверки',
    email: 'staff-' + tag + '@example.test', temporaryPassword,
  };
  let moderator;
  let moderatorId;
  let peerId;
  let listingId;
  let reportId;
  let reviewId;

  await t.test('only the primary administrator can create an unverified moderator', async () => {
    const staffEndpoint = (cookie, body, status) => api('/admin/moderators', {
      method: 'POST', cookie, body, status,
    });
    await staffEndpoint(null, moderatorAccount, 401);
    for (const participant of [seller, buyer]) await staffEndpoint(participant.cookie, moderatorAccount, 403);
    await staffEndpoint(admin.cookie, { ...moderatorAccount, temporaryPassword: 'adminadminadmin' }, 400);
    await staffEndpoint(admin.cookie, { ...moderatorAccount, role: 'ADMIN' }, 400);
    const staff = await staffEndpoint(admin.cookie, moderatorAccount, 201);
    assert.equal(staff.cookie, null);
    assert.equal(staff.data.user.username, moderatorAccount.username);
    assert.equal(staff.data.user.email, moderatorAccount.email);
    assert.equal(staff.data.user.role, 'MODERATOR');
    assert.equal(staff.data.user.emailVerified, false);
    assert.ok(!JSON.stringify(staff.data).includes(temporaryPassword));
    moderatorId = staff.data.user.id;
    await staffEndpoint(admin.cookie, {
      ...moderatorAccount, email: 'second-' + tag + '@example.test', username: moderatorAccount.username.toUpperCase(),
    }, 409);
    await staffEndpoint(admin.cookie, {
      ...moderatorAccount, email: moderatorAccount.email.toUpperCase(), username: 'different-' + tag,
    }, 409);
    const peer = await staffEndpoint(admin.cookie, {
      ...moderatorAccount, email: 'peer-' + tag + '@example.test', username: 'peer-' + tag,
    }, 201);
    peerId = peer.data.user.id;
    await api('/auth/register', {
      method: 'POST', status: 400, body: {
        username: 'public-' + tag, email: 'public-' + tag + '@example.test', password: temporaryPassword,
        role: 'MODERATOR', participantType: 'INDIVIDUAL', city: 'Томск', country: 'RU', telegram: 'public_' + tag,
        captchaToken: await solveCaptcha(origin),
      },
    });
  });

  await t.test('SMTP verifies the mailbox and password rotation gates all moderator privileges', async () => {
    const credentials = moderatorAccount;
    const challenge = await loginChallenge(credentials.username, temporaryPassword, credentials.email);
    await verify({ ...challenge, code: challenge.code === '000000' ? '000001' : '000000' }, 400);
    const activation = await verify(challenge);
    assert.equal(activation.data.user.id, moderatorId);
    assert.equal(activation.data.user.emailVerified, true);
    assert.equal(activation.data.user.mustChangePassword, true);
    await verify(challenge, 400);
    await api('/admin/users', { cookie: activation.cookie, status: 403 });
    await api('/admin/listings', { cookie: activation.cookie, status: 403 });
    await api('/admin/audit', { cookie: activation.cookie, status: 403 });
    await api('/admin/categories', { cookie: activation.cookie, status: 403 });
    const change = (newPassword, currentPassword, expected) => api('/auth/password', {
      method: 'POST', cookie: activation.cookie, body: { currentPassword, newPassword }, status: expected,
    });
    await change('adminadminadmin', temporaryPassword, 400);
    await change(permanentPassword, 'incorrect-temporary', 401);
    moderator = await change(permanentPassword, temporaryPassword, 200);
    assert.equal(moderator.data.user.role, 'MODERATOR');
    assert.equal(moderator.data.user.id, moderatorId);
    assert.equal(moderator.data.user.mustChangePassword, false);
    assert.equal((await api('/auth/me', { cookie: activation.cookie })).data.user, null);
    await api('/auth/login', {
      method: 'POST', status: 401, body: { login: credentials.username, password: temporaryPassword },
    });
    await api('/auth/credentials', {
      method: 'PATCH', cookie: moderator.cookie, status: 403,
      body: { currentPassword: permanentPassword, newPassword: temporaryPassword, username: 'different-' + tag },
    });
    await api('/auth/profile', {
      method: 'PATCH', cookie: moderator.cookie, body: { city: 'Томск' }, status: 403,
    });
    const visible = (await api('/admin/users', { cookie: moderator.cookie })).data.items;
    assert.ok(visible.some(user => user.id === seller.data.user.id));
    assert.equal(visible.find(user => user.id === adminId).email, null);
    const protectedProfile = (await api('/admin/users/' + peerId, { cookie: moderator.cookie })).data;
    assert.equal(protectedProfile.email, null);
  });

  await t.test('staff moderate catalog, listings, profiles, categories and site settings', async () => {
    const title = 'Контекстная карточка ' + tag;
    const slug = 'context-' + tag;
    const { data: category } = await api('/admin/categories', {
      method: 'POST', cookie: moderator.cookie, body: { slug, name: 'Категория проверки ' + tag }, status: 201,
    });
    await api('/admin/categories/' + category.id, {
      method: 'PATCH', cookie: admin.cookie, body: { name: 'Редактируемая категория ' + tag },
    });
    const { data: offer } = await api('/listings', {
      method: 'POST', cookie: seller.cookie, status: 201, body: {
        kind: 'SELL', categoryId: category.id, title, description: 'Серверная карта для испытания модерации.',
        availability: 'STOCK', originCountry: 'RU', stockCity: 'Томск',
      },
    });
    listingId = offer.id;
    const listing = '/listings/' + listingId;
    for (const actor of [admin, moderator]) {
      await api('/listings/mine', { cookie: actor.cookie, status: 403 });
      await api('/chats', { method: 'POST', cookie: actor.cookie, body: { listingId }, status: 403 });
      const edited = await api('/admin' + listing, {
        method: 'PATCH', cookie: actor.cookie, body: { title: title + ' ' + actor.data.user.role },
      });
      assert.equal(edited.data.id, listingId);
      assert.ok((await api('/listings?kind=SELL&q=' + encodeURIComponent(title), { cookie: actor.cookie })).data.items
        .some(item => item.id === listingId));
      assert.ok((await api('/listings?kind=BUY', { cookie: actor.cookie })).data.items.every(item => item.kind === 'BUY'));
    }

    const profileId = seller.data.user.id;
    const edited = await api('/admin/users/' + profileId, {
      method: 'PATCH', cookie: moderator.cookie, body: { city: 'Казань' },
    });
    assert.equal(edited.data.role, 'SELLER');
    assert.equal((await api('/admin/users/' + profileId, { cookie: moderator.cookie })).data.city, 'Казань');
    await api('/admin/users/' + profileId, { cookie: buyer.cookie, status: 403 });

    const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#4f6f8a' } }).png().toBuffer();
    const form = new FormData();
    form.set('data', JSON.stringify({ imageOrder: [{ fileIndex: 0 }] }));
    form.set('images', new Blob([bytes], { type: 'image/png' }), 'moderator-edit.png');
    const upload = await api('/admin' + listing, { method: 'PATCH', cookie: moderator.cookie, body: form });
    assert.equal(upload.data.images.length, 1);
    const imageUrl = new URL(upload.data.images[0].url, origin);
    const image = cookie => fetch(imageUrl, { headers: { Cookie: cookie } });
    await status('listings/' + listingId, moderator.cookie, 'FROZEN');
    await api(listing, { cookie: buyer.cookie, status: 404 });
    assert.equal((await image(buyer.cookie)).status, 404);
    const frozen = await api(listing, { cookie: moderator.cookie });
    assert.equal(frozen.data.status, 'FROZEN');
    assert.equal((await image(moderator.cookie)).headers.get('content-type'), 'image/webp');
    await status('listings/' + listingId, admin.cookie, 'ACTIVE');
    assert.equal((await api(listing, { cookie: buyer.cookie })).data.status, 'ACTIVE');
    await api('/agent/moderation/listings/' + listingId, {
      method: 'PATCH', body: { status: 'ACTIVE', reason },
      headers: { Authorization: 'Bearer ' + agentToken, 'Idempotency-Key': 'moderator-audit-' + tag },
    });

    await api('/admin/locales/en', {
      method: 'PUT', cookie: moderator.cookie, body: { name: 'English', active: true, messages: { Войти: 'Sign in' } },
    });
    const dictionary = (await api('/locales')).data.find(locale => locale.code === 'en');
    assert.equal(dictionary.messages.Войти, 'Sign in');
    const translations = { ru: { title: 'Страница ' + tag, body: 'Материал для проверки редактора страниц.' } };
    await api('/admin/content/' + slug, {
      method: 'PUT', cookie: moderator.cookie, body: { translations, active: true },
    });
    assert.ok((await api('/content')).data.some(item => item.key === slug));
    await api('/admin/content/' + slug, {
      method: 'PUT', cookie: admin.cookie, body: { translations, active: false },
    });
    assert.ok(!(await api('/content')).data.some(item => item.key === slug));
  });

  await t.test('contextual reports allow audited evidence but do not grant general chat access', async () => {
    const { data: chat } = await api('/chats', {
      method: 'POST', cookie: buyer.cookie, body: { listingId }, status: 201,
    });
    const notes = ['Просьба уточнить поставку.', 'Отвечаем после проверки склада.'];
    for (const [actor, body] of [[buyer, notes[0]], [seller, notes[1]]]) {
      await api('/chats/' + chat.id + '/messages', { method: 'POST', cookie: actor.cookie, body: { body }, status: 201 });
    }
    const review = await api('/chats/' + chat.id + '/reviews', {
      method: 'POST', cookie: buyer.cookie, body: { rating: 4, comment: 'Модерация отзыва.' }, status: 201,
    });
    reviewId = review.data.id;
    for (const actor of [admin, moderator]) {
      await api('/chats/' + chat.id, { cookie: actor.cookie, status: 403 });
      await api('/chats/' + chat.id + '/messages', { cookie: actor.cookie, status: 403 });
      await api('/admin/reports/' + chat.id + '/messages', { cookie: actor.cookie, status: 404 });
    }
    const report = await api('/chats/' + chat.id + '/reports', {
      method: 'POST', cookie: buyer.cookie, status: 201,
      body: { scope: 'ON_PLATFORM', reason: 'OTHER', details: 'Заявление о проблеме в переписке.' },
    });
    reportId = report.data.id;
    const detail = '/admin/reports/' + reportId;
    await api(detail + '/messages', { cookie: seller.cookie, status: 403 });
    const evidence = await api(detail + '/messages', { cookie: moderator.cookie });
    assert.deepEqual(evidence.data.items.map(item => item.body).sort(), notes.sort());
    const contextualReport = await api(detail, { cookie: moderator.cookie });
    assert.equal(contextualReport.data.id, reportId);
    const contextualReview = await api('/admin/reviews/' + reviewId, { cookie: moderator.cookie });
    assert.equal(contextualReview.data.id, reviewId);
    const scopedReports = await api('/admin/reports?subjectId=' + seller.data.user.id, { cookie: moderator.cookie });
    assert.deepEqual(scopedReports.data.items.map(item => item.id), [reportId]);
    const scopedReviews = await api('/admin/reviews?subjectId=' + seller.data.user.id, { cookie: moderator.cookie });
    assert.deepEqual(scopedReviews.data.items.map(item => item.id), [reviewId]);
    for (const table of ['reports', 'reviews']) {
      const unrelated = await api('/admin/' + table + '?subjectId=' + buyer.data.user.id, { cookie: moderator.cookie });
      assert.deepEqual(unrelated.data.items, []);
    }
    await status('reports/' + reportId, moderator.cookie, 'RESOLVED');
    await status('reviews/' + reviewId, moderator.cookie, 'HIDDEN');
    assert.equal((await api('/admin/reviews/' + reviewId, { cookie: admin.cookie })).data.status, 'HIDDEN');
  });

  await t.test('moderators and automation cannot act on staff; administrator freeze and ban revoke access', async () => {
    await api('/admin/moderators', {
      method: 'POST', cookie: moderator.cookie, body: { ...moderatorAccount, username: 'disallowed-' + tag }, status: 403,
    });
    for (const id of [adminId, moderatorId, peerId]) {
      await api('/admin/users/' + id, {
        method: 'PATCH', cookie: moderator.cookie, body: { displayName: 'Недоступная правка' }, status: 403,
      });
      await status('users/' + id, moderator.cookie, 'FROZEN', 403);
      await api('/agent/moderation/users/' + id, {
        method: 'PATCH', status: 403,
        headers: { Authorization: 'Bearer ' + agentToken, 'Idempotency-Key': 'staff-denied-' + tag + '-' + id },
        body: { status: 'FROZEN', reason },
      });
    }
    const pending = await loginChallenge(moderatorAccount.username, permanentPassword, moderatorAccount.email);
    await status('users/' + moderatorId, admin.cookie, 'FROZEN');
    assert.equal((await api('/auth/me', { cookie: moderator.cookie })).data.user, null);
    await api('/admin/users', { cookie: moderator.cookie, status: 401 });
    await api('/auth/login', {
      method: 'POST', status: 403, body: { login: moderatorAccount.username, password: permanentPassword },
    });
    await status('users/' + moderatorId, admin.cookie, 'ACTIVE');
    await verify(pending, 401);
    const fresh = await loginChallenge(moderatorAccount.username, permanentPassword, moderatorAccount.email);
    moderator = await verify(fresh);
    assert.equal(moderator.data.user.id, moderatorId);
    await api('/auth/logout', { method: 'POST', cookie: moderator.cookie, status: 204 });
    await api('/admin/users', { cookie: moderator.cookie, status: 401 });
    moderator = await verify(await loginChallenge(moderatorAccount.username, permanentPassword, moderatorAccount.email));
    await status('users/' + moderatorId, admin.cookie, 'BANNED');
    assert.equal((await api('/auth/me', { cookie: moderator.cookie })).data.user, null);
    await status('users/' + moderatorId, admin.cookie, 'ACTIVE', 409);
    const users = (await api('/admin/users?limit=100', { cookie: admin.cookie })).data.items;
    assert.deepEqual(users.filter(user => user.role === 'ADMIN').map(user => user.id), [adminId]);
  });

  await t.test('audit attributes evidence and changes to stable actor IDs and excludes credentials', async () => {
    const { data: audit } = await api('/admin/audit?limit=100', { cookie: admin.cookie });
    const actorEvents = audit.items.filter(event => event.actorUserId === moderatorId);
    const evidence = actorEvents.find(event => event.entityId === reportId && event.action === 'evidence-viewed');
    assert.ok(evidence);
    assert.equal(evidence.actorRole, 'MODERATOR');
    assert.ok(actorEvents.some(event => event.entityId === listingId && event.actorRole === 'MODERATOR'));
    assert.ok(actorEvents.some(event => event.entityId === reviewId && event.actorRole === 'MODERATOR'));
    assert.ok(actorEvents.some(event => event.entityId === adminId && event.action === 'status-denied'));
    assert.ok(actorEvents.some(event => event.entityId === moderatorId && event.action === 'login'));
    assert.ok(actorEvents.some(event => event.entityId === moderatorId && event.action === 'logout'));
    for (const action of ['profiles-listed', 'reports-listed']) {
      const entry = actorEvents.find(event => event.entityId === 'list' && event.action === action);
      assert.ok(entry);
      assert.deepEqual(Object.keys(entry.after).sort(), ['count', 'page']);
      assert.ok(entry.after.count > 0);
    }
    assert.ok(audit.items.some(event => event.entityId === moderatorId &&
      event.actorUserId === adminId && event.actorRole === 'ADMIN'));
    assert.ok(audit.items.some(event => event.entityId === listingId &&
      event.actorUserId === null && event.actorRole === 'AGENT'));
    for (const secret of [temporaryPassword, permanentPassword, agentToken]) {
      assert.ok(!JSON.stringify(audit).includes(secret), 'Audit should not contain authentication secrets');
    }
  });
});
