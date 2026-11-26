import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import sharp from 'sharp';
import pg from 'pg';

const base = process.env.HWFORAI_CONTACT_TEST_URL;
const dbUrl = process.env.HWFORAI_CONTACT_TEST_DATABASE_URL;
const runIntegration = Boolean(base && dbUrl);
const require = createRequire(import.meta.url);
const actorSeller = '00000000-0000-4000-8000-000000000001';
const actorBuyer = '00000000-0000-4000-8000-000000000002';

async function request(session, path, method = 'GET', body, status = 200) {
  const headers = session.cookie ? { Cookie: session.cookie } : {};
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers,
    body: body === undefined || body instanceof FormData ? body : JSON.stringify(body) });
  const value = await response.json().catch(() => undefined);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
  const cookie = response.headers.get('set-cookie');
  if (cookie) session.cookie = cookie.split(';', 1)[0];
  return value;
}

test('contact guard blocks transmission, preserves legacy ownership, audits escalation and protects forms',
  { skip: !runIntegration }, async () => {
    const admin = {}, buyer = {}, seller = {}, guest = {};
    await request(admin, '/auth/login', 'POST', { login: 'admin', password: 'admin' });
    await request(admin, '/auth/credentials', 'PATCH', { currentPassword: 'admin', newPassword: 'ContactTest!2026Root' });
    await request(buyer, '/auth/login', 'POST', { login: 'test2', password: 'test2' });
    await request(seller, '/auth/login', 'POST', { login: 'test1', password: 'test1' });
    const flag = (name, value) => request(admin, '/admin/settings/' + name, 'PUT', { value });
    await flag('feature_actuality', false);
    await flag('feature_trust_rating', false);
    await flag('feature_disclosure_journal', false);
    await flag('disclosure_min_level', 0);

    const categories = await request(guest, '/categories');
    const listing = { title: 'Сервер для теста контактов', description: 'Конфигурация сервера с двумя ускорителями',
      categoryId: categories.find(row => row.slug === 'servers').id, kind: 'SELL', stockCity: 'Москва', originCountry: 'RU' };
    const { id } = await request(seller, '/listings', 'POST', listing, 201);
    const chat = await request(buyer, '/chats', 'POST', { listingId: id }, 201);
    const path = '/chats/' + chat.id;
    const oldBody = 'Старое сообщение с номером 89001234561';
    const pool = new pg.Pool({ connectionString: dbUrl });
    const { DatabaseService } = require('../dist/database/database.service');
    const { ContactGuardService } = require('../dist/contact-guard/contact-guard.service');
    const previousDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    const database = new DatabaseService();
    try {
      const { rows: [old] } = await pool.query(`INSERT INTO chat_messages(chat_id, sender_id, body)
        VALUES ($1,$2,$3) RETURNING id`, [chat.id, actorSeller, oldBody]);
      await pool.query('UPDATE contact_guard_backfill SET through_message_id = $1 WHERE singleton', [old.id]);
      await new ContactGuardService(database).onApplicationBootstrap();
      assert.equal((await request(buyer, path + '/messages')).at(-1).body, oldBody);
      await flag('feature_disclosure_journal', true);
      const hidden = 'Сообщение скрыто: в нём были контакты';
      assert.equal((await request(buyer, path + '/messages')).at(-1).body, hidden);
      assert.equal((await request(buyer, path)).lastMessage.body, hidden);
      assert.equal((await request(buyer, '/chats')).items.find(item => item.id === chat.id).lastMessage.body, hidden);
      assert.equal((await request(seller, path + '/messages')).at(-1).body, oldBody);

      const { id: legacyId } = await request(seller, '/listings', 'POST', listing, 201);
      const legacyTitle = 'Dell PowerEdge R760, телефон 89001234561';
      const legacyDescription = 'Почта buyer-info@example.org';
      const legacyNick = 'Поставщик Telegram legacygpu';
      const legacyCity = 'Казань WhatsApp 89001234566';
      const legacyStockCity = 'Москва, телефон 89001234562';
      const legacySpecs = { 'Склад 89001234564': '10 шт', 'Оперативная память': '1024 ГБ', 'Контакт': '@legacygpu' };
      const { rows: [originalProfile] } = await pool.query('SELECT display_name,city FROM users WHERE id=$1', [actorSeller]);
      try {
        await pool.query('UPDATE users SET display_name=$2,city=$3 WHERE id=$1', [actorSeller, legacyNick, legacyCity]);
        await pool.query('UPDATE listings SET title=$2,description=$3,stock_city=$4,specs=$5 WHERE id=$1',
          [legacyId, legacyTitle, legacyDescription, legacyStockCity, legacySpecs]);
        const legacyPath = '/listings/' + legacyId;
        const original = row => {
          assert.equal(row.title, legacyTitle);
          assert.equal(row.description, legacyDescription);
          assert.equal(row.stockCity, legacyStockCity);
          assert.deepEqual(row.specs, legacySpecs);
          assert.equal(row.owner.nickname, legacyNick);
          assert.equal(row.owner.city, legacyCity);
        };
        await flag('feature_disclosure_journal', false);
        original(await request(buyer, legacyPath));
        await flag('feature_disclosure_journal', true);
        original(await request(seller, legacyPath));
        original((await request(seller, '/listings/mine')).items.find(row => row.id === legacyId));
        original(await request(admin, '/admin/listings/' + legacyId));
        for (const row of [
          await request(buyer, legacyPath),
          (await request(buyer, '/listings?showAll=true')).items.find(row => row.id === legacyId),
        ]) {
          assert.equal(row.title, 'Заголовок скрыт');
          assert.equal(row.description, 'Описание скрыто: в нём были контакты');
          assert.equal(row.stockCity, null);
          assert.deepEqual(row.specs, { 'Оперативная память': '1024 ГБ', 'Контакт': 'Значение скрыто' });
          assert.equal(row.owner.nickname, 'Имя скрыто');
          assert.equal(row.owner.city, null);
        }
        assert.equal((await request(buyer, '/listings/' + id)).title, listing.title);
        await flag('feature_matching', true);
        const myTitle = 'Ищу сервер Dell PowerEdge R760';
        const { id: requestId } = await request(buyer, '/listings', 'POST', {
          title: myTitle, description: 'Нужна рабочая конфигурация с гарантией', categoryId: listing.categoryId,
          kind: 'BUY', destinationCountry: 'RU', deliveryBy: new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10),
        }, 201);
        const { rows: [match] } = await pool.query(`
          INSERT INTO listing_matches (sell_listing_id,buy_listing_id,seller_id,buyer_id,type)
          VALUES ($1,$2,$3,$4,'FULL') RETURNING id
        `, [legacyId, requestId, actorSeller, actorBuyer]);
        for (const row of [
          await request(buyer, '/matches/' + match.id),
          (await request(buyer, '/matches')).items.find(row => row.id === match.id),
        ]) {
          assert.equal(row.mine.title, myTitle);
          assert.equal(row.counterpart.listing.title, 'Заголовок скрыт');
          assert.equal(row.counterpart.listing.stockCity, null);
          assert.equal(row.counterpart.owner.nickname, 'Имя скрыто');
          assert.equal(row.counterpart.owner.city, null);
        }
        assert.equal((await request(seller, '/matches/' + match.id)).mine.title, legacyTitle);
        const staffMatch = (await request(admin, '/admin/matches')).items.find(row => row.id === match.id);
        assert.equal(staffMatch.seller.listing.title, legacyTitle);
        assert.equal(staffMatch.seller.owner.nickname, legacyNick);
        const createdChat = await request(buyer, '/chats', 'POST', { listingId: legacyId }, 201);
        for (const row of [
          createdChat, await request(buyer, '/chats/' + createdChat.id),
          (await request(buyer, '/chats')).items.find(row => row.id === createdChat.id),
        ]) {
          assert.equal(row.listing.title, 'Заголовок скрыт');
          assert.equal(row.partner.nickname, 'Имя скрыто');
          assert.equal(row.partner.city, null);
        }
        assert.equal((await request(seller, '/chats/' + createdChat.id)).listing.title, legacyTitle);
        const legacyRevealPath = '/chats/' + createdChat.id + '/reveal';
        const legacyReveal = await request(seller, legacyRevealPath, 'PATCH', { action: 'REQUEST', rulesAccepted: true });
        const notices = (await request(buyer, '/notifications')).items.filter(row => row.kind === 'disclosure.request');
        assert.ok(notices.some(row => row.body.includes('Имя скрыто') && row.body.includes('Заголовок скрыт')));
        assert.ok(notices.every(row => !row.body.includes(legacyTitle) && !row.body.includes(legacyNick)));
        await request(buyer, legacyRevealPath, 'PATCH', { action: 'DECLINE', requestId: legacyReveal.revealRequestId });
      } finally {
        await pool.query('UPDATE users SET display_name=$2,city=$3 WHERE id=$1',
          [actorSeller, originalProfile.display_name, originalProfile.city]);
      }

      const post = (session, body, status) => request(session, path + '/messages', 'POST', { body }, status);
      const phone = 'мой телеграмм WhatsApp +79001234567';
      const blocked = await post(seller, phone, 422);
      assert.equal(blocked.code, 'CONTACT_BLOCKED');
      assert.deepEqual(blocked.kinds, ['PHONE','MESSENGER']);
      assert.equal((await request(buyer, path + '/messages')).length, 1);
      for (const fragment of ['8900', '123']) await post(seller, fragment, 201);
      assert.deepEqual((await post(seller, '4567', 422)).kinds, ['PHONE', 'SPLIT']);
      await post(seller, 'Цена 8 900 123 456 ₽, 240 шт', 201);
      assert.equal((await post(seller, 'Попросите в Telegram написать мне', 201)).contactWarning, false);
      assert.equal((await post(seller, 'Напиши в Telegram', 201)).contactWarning, true);
      await post(seller, 'ivan собака mail точка ru', 422);
      const fourth = await post(seller, 't.me/maxim_pro', 422);
      assert.equal(fourth.warning, true);
      await post(seller, 'https://example.org', 422);
      await post(seller, '@maxim_pro', 422);

      const events = await request(admin, '/admin/contact-blocks?userId=' + actorSeller + '&limit=3');
      assert.equal(events.total, 6);
      assert.equal(events.items.length, 3);
      assert.equal(events.items[0].userId, actorSeller);
      assert.equal(events.items[0].weekCount, 6);
      assert.equal(events.items[0].body, '@maxim_pro');
      await request(buyer, '/admin/contact-blocks', 'GET', undefined, 403);
      await request(guest, '/admin/contact-blocks', 'GET', undefined, 401);
      assert.ok((await request(seller, '/notifications')).items.some(row => row.kind === 'contacts.repeated'));
      assert.ok((await request(admin, '/notifications')).items.some(row => row.kind === 'contacts.review'));
      assert.equal((await request(admin, '/admin/reports')).items.filter(row => row.reason === 'CONTACT_BYPASS').length, 1);

      for (const [url, method, payload, field] of [
        ['/listings', 'POST', { ...listing, description: 'Звоните по телефону 8 900 123 45 67' }, 'description'],
        ['/listings/' + id, 'PATCH', { title: 'Подробности @maxim_pro' }, 'title'],
        ['/listings/' + id, 'PATCH', { specs: { GPU: 'Телега maximgpu' } }, 'spec:GPU'],
        ['/auth/profile', 'PATCH', { city: 'Москва WhatsApp +79001234565' }, 'city'],
        ['/auth/profile', 'PATCH', { displayName: 'Продавец t.me/maxim_pro' }, 'displayName'],
        [path + '/reviews', 'POST', { rating: 5, comment: 'Ответил на ivan собака mail точка ru' }, 'comment'],
        [path + '/reports', 'POST', { reason: 'OTHER', details: 'Обсудили вопрос по телефону 8 900 123 45 67' }, 'details'],
      ]) {
        const error = await request(seller, url, method, payload, 400);
        assert.equal(error.code, 'CONTACT_IN_FIELD');
        assert.equal(error.field, field);
      }

      const generated = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#335588' } }).png().toBuffer();
      const upload = (acknowledged) => {
        const body = new FormData();
        body.set('data', JSON.stringify({ imageOrder: [{ fileIndex: 0 }], imageContactAcknowledged: acknowledged }));
        body.append('images', new Blob([generated], { type: 'image/png' }), 'contact.png');
        return body;
      };
      assert.equal((await request(seller, '/listings/' + id, 'PATCH', upload(false), 400)).code, 'PHOTO_CONTACT_CONFIRMATION_REQUIRED');
      await request(seller, '/listings/' + id, 'PATCH', upload(true));
      const photoPath = '/listings/' + id + '/reports';
      assert.equal((await request(buyer, photoPath, 'POST', { reason: 'CONTACT_PHOTO' }, 201)).reason, 'CONTACT_PHOTO');
      await request(buyer, photoPath, 'POST', { reason: 'CONTACT_PHOTO' }, 409);
      await request(seller, photoPath, 'POST', { reason: 'CONTACT_PHOTO' }, 403);
      assert.ok((await request(admin, '/admin/reports')).items.some(row => row.reason === 'CONTACT_PHOTO' && row.listingId === id));

      const reveal = await request(buyer, path + '/reveal', 'PATCH', { action: 'REQUEST', rulesAccepted: true });
      await request(seller, path + '/reveal', 'PATCH', { action: 'ACCEPT', rulesAccepted: true, requestId: reveal.revealRequestId });
      assert.equal((await post(seller, phone, 201)).contactWarning, false);
      assert.equal((await request(buyer, path + '/messages')).at(-1).body, phone);
      assert.equal((await request(admin, '/admin/contact-blocks?userId=' + actorSeller)).total, 13);
    } finally {
      await pool.end();
      await database.onApplicationShutdown();
      if (previousDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDbUrl;
    }
  });
