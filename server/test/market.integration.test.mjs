import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const apiOrigin = process.env.HWFORAI_MARKET_TEST_URL?.replace(/\/$/, '');
const mailOrigin = process.env.MAILPIT_URL?.replace(/\/$/, '');
const agentToken = process.env.MODERATION_AGENT_TOKEN;
const configured = Boolean(apiOrigin && mailOrigin && agentToken);
const suffix = randomUUID().replaceAll('-', '').slice(0, 9);
const fixturePassword = 'Market-Test-fixture-48!';

async function call(path, { method = 'GET', cookie, body, headers = {}, status = 200 } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (cookie) requestHeaders.Cookie = cookie;
  const response = await fetch(apiOrigin + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? undefined : await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
  return { payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function mailCode(email) {
  const stream = await fetch(mailOrigin + '/api/v1/messages');
  assert.ok(stream.ok);
  const mailbox = await stream.json();
  const record = mailbox.messages.find(message => message.To.some(to => to.Address === email));
  assert.ok(record, 'Mailpit should receive the registration code');
  const delivery = await fetch(mailOrigin + '/api/v1/message/' + record.ID);
  assert.ok(delivery.ok);
  const message = await delivery.json();
  const code = message.Text.match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  return code;
}

async function register(role, prefix, participantType = 'COMPANY') {
  const username = prefix + suffix;
  const email = username + '@example.test';
  const { payload: { challengeId } } = await call('/auth/register', {
    method: 'POST',
    body: {
      username, email, password: fixturePassword, role,
      participantType,
      ...(participantType === 'COMPANY' ? { companyName: 'Тестовая компания' } : {}),
      city: 'Новосибирск', country: 'RU', telegram: username,
    },
    status: 201,
  });
  const session = await call('/auth/verify', {
    method: 'POST', body: { challengeId, code: await mailCode(email) },
  });
  assert.equal(session.payload.user.email, email);
  assert.ok(session.cookie);
  return { user: session.payload.user, cookie: session.cookie };
}

test('market authorization, search, chat consent, reports, reviews and agent moderation', {
  skip: !configured && 'Requires a disposable demo, Mailpit and a configured agent token',
}, async t => {
  const seller = await register('SELLER', 'seller');
  const buyer = await register('BUYER', 'buyer');
  const outsider = await register('BUYER', 'outsider', 'INDIVIDUAL');
  let admin = await call('/auth/login', {
    method: 'POST',
    body: {
      login: process.env.HWFORAI_MARKET_ADMIN_LOGIN || 'admin',
      password: process.env.HWFORAI_MARKET_ADMIN_PASSWORD || 'admin',
    },
  });
  if (admin.payload.user.mustChangePassword) {
    admin = await call('/auth/credentials', {
      method: 'PATCH', cookie: admin.cookie,
      body: { currentPassword: 'admin', newPassword: fixturePassword },
    });
  }

  let listing;
  let chat;
  let report;
  const { payload: categories } = await call('/categories');

  await t.test('listing publication, role filtering and public projection', async () => {
    const title = 'Интеграционный GPU ' + suffix;
    assert.ok(categories.length >= 10);
    assert.equal((await call('/listings')).payload.locked, true);
    ({ payload: listing } = await call('/listings', {
      method: 'POST', cookie: seller.cookie, status: 201,
      body: {
        categoryId: categories.find(category => category.slug === 'gpu').id,
        title,
        description: 'Демонстрационная карточка только для интеграционной проверки.',
        quantity: 2,
        condition: 'NEW',
        priceMode: 'FIXED',
        price: 150000,
        currency: 'RUB',
        availability: 'STOCK',
        originCountry: 'RU',
        stockCity: 'Новосибирск',
        deliveryIncluded: true,
        counterparty: 'COMPANY',
        paymentMethods: ['BANK_TRANSFER'],
        specs: { Модель: 'Test GPU ' + suffix },
      },
    }));
    await call('/listings/' + listing.id, { status: 401 });
    const matching = await call('/listings?' + new URLSearchParams({
      q: suffix, category: 'gpu', availability: 'STOCK', originCountry: 'RU',
      priceMin: '140000', priceMax: '160000', ownerType: 'COMPANY', paymentMethod: 'BANK_TRANSFER',
      deliveryIncluded: 'true', sort: 'price-asc',
    }), { cookie: buyer.cookie });
    assert.deepEqual(matching.payload.items.map(item => item.id), [listing.id]);
    assert.ok(!('telegram' in matching.payload.items[0].owner));
    assert.ok(!('email' in matching.payload.items[0].owner));
    const wrongRole = await call('/listings?kind=SELL', { cookie: seller.cookie });
    assert.deepEqual(wrongRole.payload.items, []);

    const categoryPath = '/admin/categories';
    const { payload: parent } = await call(categoryPath, {
      method: 'POST', cookie: admin.cookie, status: 201,
      body: { slug: 'parent-' + suffix, name: 'Корневая тестовая категория' },
    });
    const { payload: child } = await call(categoryPath, {
      method: 'POST', cookie: admin.cookie, status: 201,
      body: { slug: 'child-' + suffix, name: 'Дочерняя тестовая категория', parentId: parent.id },
    });
    const { payload: nested } = await call('/listings', {
      method: 'POST', cookie: seller.cookie, status: 201,
      body: {
        categoryId: child.id, title: 'Сетевой компонент ' + suffix,
        description: 'Объявление для проверки скрытой ветки каталога.',
        availability: 'ORDER', originCountry: 'RU',
      },
    });
    const nestedSearch = async () => (await call('/listings?category=' + parent.slug, { cookie: buyer.cookie })).payload.items;
    const parentVisibility = active => call(categoryPath + '/' + parent.id, {
      method: 'PATCH', cookie: admin.cookie, body: { active },
    });
    const nestedModeration = (status, expected = 200) => call('/admin/listings/' + nested.id + '/status', {
      method: 'PATCH', cookie: admin.cookie, status: expected, body: { status, reason: 'Проверка публикации категории' },
    });
    assert.deepEqual((await nestedSearch()).map(item => item.id), [nested.id]);
    await parentVisibility(false);
    assert.deepEqual(await nestedSearch(), []);
    await call('/listings/' + nested.id, { cookie: buyer.cookie, status: 404 });
    await nestedModeration('FROZEN');
    await nestedModeration('ACTIVE', 400);
    await parentVisibility(true);
    await nestedModeration('ACTIVE');
    assert.deepEqual((await nestedSearch()).map(item => item.id), [nested.id]);
  });

  await t.test('chat membership, warning and mutual consent including reset', async () => {
    await call('/chats', {
      method: 'POST', cookie: outsider.cookie, status: 403, body: { listingId: listing.id },
    });
    ({ payload: chat } = await call('/chats', {
      method: 'POST', cookie: buyer.cookie, status: 201, body: { listingId: listing.id },
    }));
    assert.equal(chat.telegram, null);
    await call('/chats/' + chat.id, { cookie: outsider.cookie, status: 404 });
    await call('/chats/' + chat.id + '/reviews', {
      method: 'POST', cookie: buyer.cookie, body: { rating: 4 }, status: 409,
    });
    const flagged = await call('/chats/' + chat.id + '/messages', {
      method: 'POST', cookie: buyer.cookie, status: 201, body: { body: 'Внешний контакт @unverified123' },
    });
    assert.equal(flagged.payload.contactWarning, true);
    await call('/chats/' + chat.id + '/messages', {
      method: 'POST', cookie: seller.cookie, status: 201, body: { body: 'Продолжим переговоры на площадке.' },
    });
    await call('/chats/' + chat.id + '/reports', {
      method: 'POST', cookie: buyer.cookie, status: 400,
      body: { reason: 'OTHER', scope: 'VERIFIED_TELEGRAM', details: 'Согласие ещё не было получено.' },
    });
    const reveal = (action, cookie, status = 200) => call('/chats/' + chat.id + '/reveal', {
      method: 'PATCH', cookie, body: { action }, status,
    });
    assert.equal((await reveal('REQUEST', buyer.cookie)).payload.telegram, null);
    await reveal('ACCEPT', buyer.cookie, 409);
    assert.equal((await reveal('ACCEPT', seller.cookie)).payload.telegram.partner, buyer.user.telegram);
    const mine = (await call('/chats/' + chat.id, { cookie: buyer.cookie })).payload;
    assert.equal(mine.telegram.partner, seller.user.telegram);

    await call('/auth/profile', {
      method: 'PATCH', cookie: seller.cookie, body: { telegram: 'changed' + suffix },
    });
    await call('/auth/profile', {
      method: 'PATCH', cookie: seller.cookie, body: { telegram: seller.user.telegram },
    });
    const reset = (await call('/chats/' + chat.id, { cookie: buyer.cookie })).payload;
    assert.equal(reset.revealState, 'NONE');
    assert.equal(reset.telegram, null);
  });

  await t.test('review trust and historic evidence for moderation', async () => {
    const reviewRequest = { method: 'POST', cookie: buyer.cookie, body: { rating: 4, comment: 'Ответил на вопросы.' } };
    await call('/chats/' + chat.id + '/reviews', {
      ...reviewRequest, status: 400, body: { rating: 4, comment: 'Свяжитесь по https://example.test' },
    });
    await call('/chats/' + chat.id + '/reviews', { ...reviewRequest, status: 201 });
    await call('/chats/' + chat.id + '/reviews', { ...reviewRequest, status: 409 });
    const details = await call('/listings/' + listing.id, { cookie: buyer.cookie });
    assert.equal(details.payload.owner.rating, 4);
    assert.equal(details.payload.owner.ratingCount, 1);
    ({ payload: report } = await call('/chats/' + chat.id + '/reports', {
      method: 'POST', cookie: buyer.cookie, status: 201,
      body: { reason: 'OTHER', scope: 'VERIFIED_TELEGRAM', details: 'Разбор общения по ранее раскрытому каналу.' },
    }));
    const evidencePath = '/admin/reports/' + report.id + '/messages';
    await call(evidencePath, { cookie: outsider.cookie, status: 403 });
    const evidence = (await call(evidencePath, { cookie: admin.cookie })).payload;
    assert.equal((Array.isArray(evidence) ? evidence : evidence.items).length, 2);
  });

  await t.test('agent scope, idempotency and irreversible ban', async () => {
    const key = 'market-check-' + suffix;
    const path = '/agent/moderation/listings/' + listing.id;
    const freeze = { status: 'FROZEN', reason: 'Тестовая проверка объявления' };
    await call(path, { method: 'PATCH', body: freeze, status: 401 });
    const agent = (body, idempotencyKey, status = 200) => call(path, {
      method: 'PATCH', body, status,
      headers: { Authorization: 'Bearer ' + agentToken, 'Idempotency-Key': idempotencyKey },
    });
    const first = (await agent(freeze, key)).payload;
    assert.equal(first.changed, true);
    assert.equal(first.replayed, false);
    const second = (await agent(freeze, key)).payload;
    assert.equal(second.replayed, true);
    await agent({ ...freeze, reason: 'Несовпадающий повтор' }, key, 409);
    await call('/listings/' + listing.id, { cookie: buyer.cookie, status: 404 });
    await call('/chats/' + chat.id + '/messages', {
      method: 'POST', cookie: buyer.cookie, body: { body: 'Проверка заморозки.' }, status: 403,
    });
    await call('/admin/listings', { headers: { Authorization: 'Bearer ' + agentToken }, status: 401 });
    await agent({ status: 'ACTIVE', reason: 'Проверка завершена' }, key + '.restore');
    await call('/listings/' + listing.id, { cookie: buyer.cookie });
    await agent({ status: 'BANNED', reason: 'Постоянная тестовая блокировка' }, key + '.ban');
    await agent({ status: 'ACTIVE', reason: 'Попытка восстановления' }, key + '.invalid', 409);

    const audit = (await call('/admin/audit?limit=100', { cookie: admin.cookie })).payload;
    const events = audit.items.filter(event => event.entityId === listing.id && event.actor === 'agent:moderation');
    assert.equal(events.length, 3);
    assert.ok(audit.items.some(event => event.entityId === report.id));
  });

  await t.test('administrator freezes profiles and moderates review visibility', async () => {
    const userPath = '/admin/users/' + buyer.user.id + '/status';
    const moderate = (path, status) => call(path, {
      method: 'PATCH', cookie: admin.cookie, body: { status, reason: 'Проверка модерации' },
    });
    await moderate(userPath, 'FROZEN');
    await call('/listings/mine', { cookie: buyer.cookie, status: 401 });
    const loginBody = { login: buyer.user.username, password: fixturePassword };
    await call('/auth/login', { method: 'POST', body: loginBody, status: 403 });
    await moderate(userPath, 'ACTIVE');
    assert.equal((await call('/auth/me', { cookie: buyer.cookie })).payload.user, null);
    const { payload: { challengeId } } = await call('/auth/login', { method: 'POST', body: loginBody });
    const renewed = await call('/auth/verify', {
      method: 'POST', body: { challengeId, code: await mailCode(buyer.user.email) },
    });
    assert.equal(renewed.payload.user.id, buyer.user.id);
    buyer.cookie = renewed.cookie;

    const reviews = (await call('/admin/reviews?limit=100', { cookie: admin.cookie })).payload;
    const review = reviews.items.find(item => item.chatId === chat.id);
    assert.ok(review);
    await moderate('/admin/reviews/' + review.id + '/status', 'HIDDEN');
    const dialog = (await call('/chats/' + chat.id, { cookie: buyer.cookie })).payload;
    assert.equal(dialog.partner.rating, null);
    assert.equal(dialog.partner.ratingCount, 0);
    await moderate('/admin/reports/' + report.id + '/status', 'RESOLVED');
  });

  await t.test('published language and managed page are available to guests', async () => {
    await call('/admin/locales/en', {
      method: 'PUT', cookie: admin.cookie,
      body: { name: 'English', active: true, messages: { Войти: 'Sign in' } },
    });
    const locales = (await call('/locales')).payload;
    assert.equal(locales.find(locale => locale.code === 'en').messages.Войти, 'Sign in');

    const key = 'qa-page-' + suffix;
    const translations = { ru: { title: 'Тестовая страница', body: 'Проверка содержимого страницы.' },
      en: { title: 'Test page', body: 'Check the page content.' } };
    await call('/admin/content/' + key, {
      method: 'PUT', cookie: admin.cookie, body: { translations, active: true },
    });
    const pages = (await call('/content')).payload;
    assert.equal(pages.find(page => page.key === key).translations.en.title, translations.en.title);
  });
});
