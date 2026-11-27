import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs';

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
      ...demoRegistrationConsent,
      username, email, password: fixturePassword, role, captchaToken: await solveCaptcha(apiOrigin),
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
  const adminCredentials = {
    login: process.env.HWFORAI_MARKET_ADMIN_LOGIN || 'admin',
    password: process.env.HWFORAI_MARKET_ADMIN_PASSWORD || 'admin',
  };
  let admin = await call('/auth/login', {
    method: 'POST', body: adminCredentials,
  });
  if (admin.payload.user.mustChangePassword) {
    const newPassword = 'Moderation-Test-fixture-74!';
    admin = await call('/auth/credentials', {
      method: 'PATCH', cookie: admin.cookie,
      body: { currentPassword: adminCredentials.password, newPassword },
    });
    adminCredentials.password = newPassword;
  }

  await t.test('administrator registration is closed and credentials are scoped to the session owner', async () => {
    const administrator = admin.payload.user;
    const username = 'invalid-admin-' + suffix;
    const registration = await call('/auth/register', {
      method: 'POST', status: 400, body: {
        ...demoRegistrationConsent,
        username, email: username + '@example.test', password: fixturePassword, role: 'ADMIN',
        captchaToken: await solveCaptcha(apiOrigin),
        participantType: 'INDIVIDUAL', city: 'Пермь', country: 'RU', telegram: 'invalid_admin_' + suffix,
      },
    });
    assert.match(String(registration.payload.message), /покупаете вы, продаёте или совмещаете обе стороны/);

    const passwordChange = { currentPassword: adminCredentials.password, newPassword: 'Unused-admin-replacement-' + suffix };
    for (const { cookie } of [buyer, seller]) {
      await call('/admin/users/' + administrator.id, {
        method: 'PATCH', cookie, status: 403, body: { username, ...passwordChange },
      });
      await call('/auth/credentials', {
        method: 'PATCH', cookie, status: 403, body: { username, ...passwordChange },
      });
      await call('/auth/credentials', {
        method: 'PATCH', cookie, status: 400, body: { userId: administrator.id, ...passwordChange },
      });
      for (const target of [{ userId: administrator.id }, { username: administrator.username }]) {
        await call('/auth/password', { method: 'POST', cookie, status: 400, body: { ...target, ...passwordChange } });
      }
      if (adminCredentials.password !== fixturePassword) {
        await call('/auth/password', { method: 'POST', cookie, status: 401, body: passwordChange });
      }
    }
    await call('/auth/credentials', {
      method: 'PATCH', cookie: admin.cookie, status: 400, body: { userId: buyer.user.id, ...passwordChange },
    });

    const changed = await call('/auth/password', {
      method: 'POST', cookie: outsider.cookie, body: {
        currentPassword: fixturePassword, newPassword: 'Member-self-password-' + suffix,
      },
    });
    assert.equal(changed.payload.user.id, outsider.user.id);
    assert.equal(changed.payload.user.role, outsider.user.role);
    outsider.cookie = changed.cookie;
    const confirmed = await call('/auth/login', { method: 'POST', body: adminCredentials });
    assert.equal(confirmed.payload.user.id, administrator.id);
    assert.equal(confirmed.payload.user.username, administrator.username);
    assert.equal(confirmed.payload.user.role, 'ADMIN');
  });

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
        modelId: 'h100-sxm',
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
      priceMin: '140000', priceMax: '160000', currency: 'RUB', ownerType: 'COMPANY', paymentMethod: 'BANK_TRANSFER',
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

  await t.test('flexible seller origins match country searches and can be edited', async () => {
    const title = 'Тест географии отгрузки ' + suffix;
    const fixture = {
      categoryId: listing.categoryId,
      modelId: listing.modelId,
      title,
      description: 'Проверяем условия отгрузки со склада и фильтр по стране.',
      availability: 'STOCK',
    };
    const create = (body, status) => call('/listings', {
      method: 'POST', cookie: seller.cookie, status, body: { ...fixture, ...body },
    });
    await create({ originScope: 'DOMESTIC', stockCity: 'Казань' }, 400);
    await create({ originScope: 'ANY', originCountry: 'RU', stockCity: 'Казань' }, 400);
    await create({ originScope: 'ANY' }, 400);
    const { payload: flexible } = await create({ originScope: 'ANY', originCountry: null, stockCity: 'Казань' }, 201);
    assert.equal(flexible.originScope, 'ANY');
    assert.equal(flexible.originCountry, null);
    assert.equal(flexible.stockCity, 'Казань');

    const search = async filters => (await call('/listings?' + new URLSearchParams({
      q: title, ...filters,
    }), { cookie: buyer.cookie })).payload.items.map(item => item.id);
    const edit = async body => (await call('/listings/' + flexible.id, {
      method: 'PATCH', cookie: seller.cookie, body,
    })).payload;
    assert.deepEqual(await search({ country: 'ANY' }), [flexible.id]);
    assert.deepEqual(await search({ originCountry: 'CN' }), [flexible.id]);
    assert.deepEqual(await search({ originScope: 'COUNTRY' }), []);
    assert.equal((await edit({ quantity: 2 })).originScope, 'ANY');

    const specific = await edit({ originCountry: 'KZ' });
    assert.equal(specific.originScope, 'COUNTRY');
    assert.equal(specific.originCountry, 'KZ');
    assert.deepEqual(await search({ originCountry: 'CN' }), []);
    assert.deepEqual(await search({ originCountry: 'KZ', originScope: 'COUNTRY' }), [flexible.id]);
    assert.deepEqual(await search({ originCountry: 'ANY' }), []);

    const switchedBack = await edit({ originScope: 'ANY' });
    assert.equal(switchedBack.originScope, 'ANY');
    assert.equal(switchedBack.originCountry, null);
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
    const open = async (listingId, cookie) => (await call('/chats', {
      method: 'POST', cookie, status: 201, body: { listingId },
    })).payload;
    const detail = async (chatId, cookie) => (await call('/chats/' + chatId, { cookie })).payload;
    const reveal = async (chatId, action, cookie, requestId, status = 200) => (await call('/chats/' + chatId + '/reveal', {
      method: 'PATCH', cookie, body: { action, requestId }, status,
    })).payload;
    const { payload: offer } = await call('/listings', {
      method: 'POST', cookie: seller.cookie, status: 201,
      body: { categoryId: listing.categoryId, modelId: listing.modelId, title: 'Дополнительная поставка ' + suffix,
        description: 'Второе объявление для проверки общего доступа к контакту.', availability: 'ORDER', originCountry: 'RU' },
    });
    const sibling = await open(offer.id, buyer.cookie);
    const foreignChat = await open(offer.id, outsider.cookie);
    const pending = await reveal(chat.id, 'REQUEST', buyer.cookie);
    assert.equal(pending.telegram, null);
    assert.ok(pending.revealRequestId);
    assert.equal((await detail(sibling.id, seller.cookie)).revealRequestId, pending.revealRequestId);
    assert.equal((await detail(foreignChat.id, seller.cookie)).revealRequestId, null);
    await reveal(chat.id, 'ACCEPT', buyer.cookie, pending.revealRequestId, 409);
    await reveal(sibling.id, 'ACCEPT', seller.cookie, undefined, 400);
    assert.equal((await reveal(sibling.id, 'ACCEPT', seller.cookie, pending.revealRequestId)).telegram.partner, buyer.user.telegram);
    assert.equal((await detail(chat.id, buyer.cookie)).telegram.partner, seller.user.telegram);
    assert.equal((await detail(foreignChat.id, outsider.cookie)).canReportTelegram, false);
    const sendHandle = async () => (await call('/chats/' + sibling.id + '/messages', {
      method: 'POST', cookie: buyer.cookie, status: 201, body: { body: 'Продолжим в @' + seller.user.telegram },
    })).payload;
    assert.equal((await sendHandle()).contactWarning, false);

    const { payload: wanted } = await call('/listings', {
      method: 'POST', cookie: buyer.cookie, status: 201,
      body: { categoryId: listing.categoryId, modelId: listing.modelId, title: 'Запрос на поставку ' + suffix,
        description: 'Проверка общей истории контактов с обратными ролями в чате.',
        destinationCountry: 'RU', deliveryBy: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) },
    });
    const reversed = await open(wanted.id, seller.cookie);
    assert.deepEqual(reversed.telegram, { mine: seller.user.telegram, partner: buyer.user.telegram });
    assert.equal(reversed.canReportTelegram, true);
    const moderateOffer = status => call('/admin/listings/' + offer.id + '/status', {
      method: 'PATCH', cookie: admin.cookie, body: { status, reason: 'Проверка изоляции доступа к чату' },
    });
    await moderateOffer('FROZEN');
    const restricted = await detail(sibling.id, buyer.cookie);
    assert.equal(restricted.status, 'RESTRICTED');
    assert.equal(restricted.telegram, null);
    await reveal(sibling.id, 'REQUEST', buyer.cookie, undefined, 403);
    assert.equal((await detail(chat.id, buyer.cookie)).telegram.partner, seller.user.telegram);
    await moderateOffer('ACTIVE');

    const changeHandle = (cookie, telegram) => call('/auth/profile', {
      method: 'PATCH', cookie, body: { telegram },
    });
    await changeHandle(seller.cookie, seller.user.telegram.toUpperCase());
    assert.equal((await detail(chat.id, buyer.cookie)).revealState, 'ACCEPTED');
    await changeHandle(seller.cookie, 'changed' + suffix);
    for (const chatId of [chat.id, sibling.id, reversed.id]) {
      const reset = await detail(chatId, buyer.cookie);
      assert.equal(reset.revealState, 'NONE');
      assert.equal(reset.telegram, null);
      assert.equal(reset.canReportTelegram, true);
      assert.deepEqual(reset.telegramChanged, { mine: false, partner: true });
    }
    assert.deepEqual((await detail(reversed.id, seller.cookie)).telegramChanged, { mine: true, partner: false });
    assert.equal((await detail(foreignChat.id, outsider.cookie)).telegramChanged, null);
    assert.equal((await sendHandle()).contactWarning, true);

    const renewal = await reveal(reversed.id, 'REQUEST', seller.cookie);
    await changeHandle(seller.cookie, seller.user.telegram);
    await reveal(chat.id, 'ACCEPT', buyer.cookie, renewal.revealRequestId, 409);
    const newest = await reveal(sibling.id, 'REQUEST', seller.cookie);
    assert.notEqual(newest.revealRequestId, renewal.revealRequestId);
    await reveal(chat.id, 'ACCEPT', buyer.cookie, renewal.revealRequestId, 409);
    assert.equal((await detail(chat.id, buyer.cookie)).telegram, null);
    assert.deepEqual(newest.telegramChanged, { mine: true, partner: false });
    const decline = await reveal(chat.id, 'DECLINE', buyer.cookie, newest.revealRequestId);
    assert.equal(decline.revealState, 'DECLINED');
    assert.deepEqual(decline.telegramChanged, { mine: false, partner: true });
    const retry = await reveal(chat.id, 'REQUEST', buyer.cookie);
    const acceptances = await Promise.allSettled([reversed.id, sibling.id].map(chatId =>
      reveal(chatId, 'ACCEPT', seller.cookie, retry.revealRequestId),
    ));
    const successes = acceptances.filter(result => result.status === 'fulfilled');
    const rejections = acceptances.filter(result => result.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(successes[0].value.telegramChanged, null);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].reason.actual, 409);
    assert.equal((await detail(chat.id, buyer.cookie)).telegram.partner, seller.user.telegram);
    const index = (await call('/chats', { cookie: buyer.cookie })).payload.items;
    assert.deepEqual(index.find(item => item.id === sibling.id).telegram, { mine: buyer.user.telegram, partner: seller.user.telegram });
    assert.equal(index.find(item => item.id === sibling.id).telegramChanged, null);

    // Historical reporting remains available after a change by the buyer too.
    await changeHandle(buyer.cookie, 'changedbuyer' + suffix);
    assert.equal((await detail(chat.id, seller.cookie)).telegram, null);
    assert.deepEqual((await detail(sibling.id, seller.cookie)).telegramChanged, { mine: false, partner: true });
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

  await t.test('one public reputation rating per counterparty across listing chats', async () => {
    const { payload: anotherListing } = await call('/listings', {
      method: 'POST', cookie: seller.cookie, status: 201,
      body: {
        categoryId: listing.categoryId, modelId: listing.modelId, title: 'Другой GPU ' + suffix,
        description: 'Карточка для проверки отзывов от повторного и нового собеседника.',
        quantity: 1, priceMode: 'NEGOTIABLE', availability: 'ORDER', originScope: 'ANY',
      },
    });
    const review = async (author, rating) => {
      const { payload: thread } = await call('/chats', {
        method: 'POST', cookie: author.cookie, body: { listingId: anotherListing.id }, status: 201,
      });
      for (const participant of [author, seller]) {
        await call('/chats/' + thread.id + '/messages', {
          method: 'POST', cookie: participant.cookie, body: { body: 'Можно обсудить совместимость?' }, status: 201,
        });
      }
      return (await call('/chats/' + thread.id + '/reviews', {
        method: 'POST', cookie: author.cookie, body: { rating }, status: 201,
      })).payload;
    };
    const checkRating = async (rating, ratingCount) => {
      const { payload } = await call('/listings/' + listing.id, { cookie: buyer.cookie });
      assert.equal(payload.owner.rating, rating);
      assert.equal(payload.owner.ratingCount, ratingCount);
    };
    const hideReview = id => call('/admin/reviews/' + id + '/status', {
      method: 'PATCH', cookie: admin.cookie, body: { status: 'HIDDEN', reason: 'Проверка расчёта репутации' },
    });
    const latest = await review(buyer, 2);
    await checkRating(2, 1);
    const independent = await review(outsider, 5);
    await checkRating(3.5, 2);
    await hideReview(latest.id);
    await checkRating(4.5, 2);
    await hideReview(independent.id);
  });

  await t.test('agent scope, idempotency and irreversible ban', async () => {
    const key = 'market-check-' + suffix;
    const path = '/agent/moderation/listings/' + listing.id;
    const freeze = { status: 'FROZEN', reason: 'Тестовая проверка объявления' };
    const adminId = admin.payload.user.id;
    const agentHeaders = { Authorization: 'Bearer ' + agentToken, 'Idempotency-Key': key + '.scope' };
    const protectedRoutes = ['/admin/users', '/admin/audit', '/admin/reports/' + report.id + '/messages'];
    for (const route of protectedRoutes) {
      await call(route, { headers: agentHeaders, status: 401 });
      await call(route, { cookie: buyer.cookie, status: 403 });
      await call(route, { cookie: seller.cookie, status: 403 });
    }
    await call('/admin/categories', { method: 'POST', cookie: seller.cookie, body: {}, status: 403 });
    await call('/admin/content/about', { method: 'PUT', cookie: buyer.cookie, body: {}, status: 403 });
    await call('/auth/profile', { method: 'PATCH', cookie: seller.cookie, body: { role: 'ADMIN' }, status: 400 });
    await call('/admin/users/' + buyer.user.id, {
      method: 'PATCH', cookie: admin.cookie, body: { role: 'ADMIN' }, status: 400,
    });
    await call('/admin/users/' + adminId, {
      method: 'PATCH', cookie: admin.cookie, body: { displayName: 'Непубличная правка' }, status: 403,
    });
    await call('/admin/users/' + adminId + '/status', {
      method: 'PATCH', cookie: admin.cookie, body: freeze, status: 403,
    });
    await call('/agent/moderation/users/' + adminId, {
      method: 'PATCH', headers: agentHeaders, body: freeze, status: 403,
    });
    await call('/agent/moderation/reports/' + report.id, {
      method: 'PATCH', headers: agentHeaders, body: freeze, status: 400,
    });
    await call('/agent/moderation/users/' + buyer.user.id, {
      method: 'PATCH', headers: agentHeaders, body: { ...freeze, role: 'ADMIN' }, status: 400,
    });
    const amended = (await call('/admin/users/' + buyer.user.id, {
      method: 'PATCH', cookie: admin.cookie, body: { city: 'Казань' },
    })).payload;
    assert.equal(amended.role, 'BUYER');
    assert.equal(amended.city, 'Казань');

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
    assert.ok(events.every(event => event.actorUserId === null));
    const evidenceAudit = audit.items.filter(event => event.entityId === report.id && event.action === 'evidence-viewed');
    assert.equal(evidenceAudit.length, 1);
    assert.equal(evidenceAudit[0].actorUserId, adminId);
    assert.deepEqual(evidenceAudit[0].after, { page: 1 });
    const editAudit = audit.items.find(event => event.entityId === buyer.user.id && event.action === 'edited');
    assert.equal(editAudit.actorUserId, adminId);
    assert.ok(!('telegram' in editAudit.before) && !('email' in editAudit.before));
    assert.ok(!('telegram' in editAudit.after) && !('email' in editAudit.after));
    assert.equal(editAudit.after.telegramChanged, false);
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
