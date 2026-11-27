import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

const base = process.env.HWFORAI_NOTIFICATIONS_TEST_URL;
const dbUrl = process.env.HWFORAI_NOTIFICATIONS_TEST_DATABASE_URL;
const require = createRequire(import.meta.url);

async function request(session, path, { method = 'GET', body, status = 200 } = {}) {
  const headers = session.cookie ? { Cookie: session.cookie } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  const cookie = response.headers.get('set-cookie');
  if (cookie) session.cookie = cookie.split(';', 1)[0];
  return result;
}

const patch = (body, status = 200) => ({ method: 'PATCH', body, status });
const post = (body, status = 201) => ({ method: 'POST', body, status });

test('notification workflows on PostgreSQL and the demo API', { skip: !(base && dbUrl) }, async (t) => {
  const { DatabaseService } = require('../dist/database/database.service');
  const { ExchangeJobs } = require('../dist/exchange/jobs');
  const { ExchangeNotifications } = require('../dist/exchange/notifications');
  const { PlatformSettings } = require('../dist/exchange/platform-settings');
  const { ExchangeActions } = require('../dist/exchange/actions');
  const { ActualityService } = require('../dist/exchange/actuality.service');
  const { ActualityJobs } = require('../dist/exchange/actuality.jobs');
  const { MatchingService } = require('../dist/matching/matching.service');
  const databaseName = new URL(dbUrl).pathname.slice(1);
  assert.match(databaseName, /^(maxv_baseline_|hwforai_notifications_)/, 'Use a disposable test database');
  const oldDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = dbUrl;
  const db = new DatabaseService();
  t.after(async () => {
    if (oldDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDbUrl;
    await db.onApplicationShutdown();
  });
  const settings = new PlatformSettings(db);
  const jobs = new ExchangeJobs(db, settings);
  const sent = [];
  const notifications = new ExchangeNotifications(db, jobs, {
    sendMessage: async (to, subject, body) => sent.push({ to, subject, body }),
  });
  notifications.onModuleInit();
  const actions = new ExchangeActions(db);
  new MatchingService(db, settings, jobs, notifications, null, actions, null).onModuleInit();
  const noTrust = { refresh: async () => {} };
  const actuality = new ActualityService(db, settings, actions, null, noTrust, notifications);
  const actualityJobs = new ActualityJobs(jobs, actuality, notifications, actions, noTrust);
  const guest = {}, buyer = {}, seller = {}, admin = {};
  const login = (session, name) => request(session, '/auth/login', post({ login: name, password: name }, 200));
  const buyerUser = (await login(buyer, 'test2')).user;
  const sellerUser = (await login(seller, 'test1')).user;
  const administrator = (await login(admin, 'admin')).user;
  await request(admin, '/auth/credentials', patch({ currentPassword: 'admin', newPassword: 'NotificationsQa!2026' }));
  const flag = (key, value) => request(admin, '/admin/settings/' + key, { method: 'PUT', body: { value } });
  await flag('feature_actuality', false);
  await flag('feature_disclosure_journal', false);
  await flag('feature_trust_rating', false);
  await flag('staff_digest_hour', 0);
  const categories = await request(guest, '/categories');
  const servers = categories.find(category => category.slug === 'servers');
  const publish = (title, fields = {}) => request(seller, '/listings', post({
    title, description: 'Описание серверной конфигурации для приёмки уведомлений',
    categoryId: servers.id, modelId: 'hgx-h200-8', kind: 'SELL', originCountry: 'RU', stockCity: 'Москва',
    ...fields,
  }));
  const listing = await publish('Проверка уведомлений');
  const chat = await request(buyer, '/chats', post({ listingId: listing.id }));
  const path = '/chats/' + chat.id;
  const notices = async (session, kind) => (await request(session, '/notifications?limit=100')).items.filter(item => item.kind === kind);
  const chatMail = () => sent.filter(row => row.to === sellerUser.email && row.subject.startsWith('У вас новые сообщения'));
  let run = 0;
  async function runJob(name) {
    // The live server and this in-process service share the production advisory lock.
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await jobs.runNow(name, name === 'staff.digest' ? undefined : 'qa:' + ++run);
      if (result.status !== 'SKIPPED') {
        assert.equal(result.status, 'DONE', name);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(name + ' never acquired its lock');
  }

  await t.test('one unread alert per thread, delayed throttled mail, read cancellation and aggregate counters', async () => {
    await request(guest, '/chats/unread-count', { status: 401 });
    await request(admin, '/chats/unread-count', { status: 403 });
    const firstBody = 'Приватная переписка о параметрах поставки';
    const first = await request(buyer, path + '/messages', post({ body: firstBody }));
    const [notice] = await notices(seller, 'chat.message');
    assert.equal(notice.title, 'Новое сообщение от ' + buyerUser.displayName);
    assert.equal(notice.body, 'По объявлению «Проверка уведомлений»');
    assert.ok(!JSON.stringify(notice).includes(firstBody));
    assert.equal(notice.actions[0].href, path);
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    assert.equal(chatMail().length, 0);
    const age = () => db.query(`
      UPDATE chat_notify_state SET pending_since=now()-interval '6 minutes' WHERE chat_id=$1 AND user_id=$2
    `, [chat.id, sellerUser.id]);
    await age();
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    assert.equal(chatMail().length, 1);
    assert.doesNotMatch(chatMail()[0].body, new RegExp(firstBody));
    let latest;
    for (const body of ['Уточнение по сроку', 'Уточнение по оплате', 'Уточнение по упаковке']) {
      latest = await request(buyer, path + '/messages', post({ body }));
    }
    const active = await notices(seller, 'chat.message');
    assert.equal(active.length, 1);
    assert.equal(active[0].payload.count, 4);
    assert.equal(active[0].body, 'Новых сообщений: 4');
    await age();
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    assert.equal(chatMail().length, 1);
    await db.query("UPDATE chat_notify_state SET last_email_at=now()-interval '16 minutes' WHERE chat_id=$1", [chat.id]);
    await db.query(`
      UPDATE notification_deliveries d SET sent_at=now()-interval '16 minutes'
      FROM notifications n WHERE d.notification_id=n.id AND n.kind='chat.message' AND n.payload->>'chatId'=$1 AND d.status='SENT'
    `, [chat.id]);
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    assert.equal(chatMail().length, 2);
    assert.deepEqual(await request(seller, '/chats/unread-count'), { unread: 4 });
    assert.deepEqual(await request(seller, '/notifications/counts'), { unread: 1, chats: 4 });
    await request(seller, path + '/read', patch({ messageId: first.id }, 204));
    assert.equal((await notices(seller, 'chat.message'))[0].payload.count, 3);
    await request(seller, path + '/read', patch({ messageId: latest.id }, 204));
    assert.equal((await request(seller, '/notifications/counts')).chats, 0);
    assert.ok((await notices(seller, 'chat.message'))[0].readAt);
    const cancelled = await request(buyer, path + '/messages', post({ body: 'Прочитано до отправки письма' }));
    await request(seller, path + '/read', patch({ messageId: cancelled.id }, 204));
    await db.query("UPDATE chat_notify_state SET last_email_at=now()-interval '16 minutes' WHERE chat_id=$1", [chat.id]);
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    assert.equal(chatMail().length, 2);
    for (const total of [2, 1, 5]) {
      const offer = await publish('Проверка счётчика ' + total);
      const conversation = await request(buyer, '/chats', post({ listingId: offer.id }));
      for (let index = 0; index < total; index++) {
        await request(buyer, '/chats/' + conversation.id + '/messages', post({ body: 'Согласуем поставку' }));
      }
    }
    assert.deepEqual(await request(seller, '/chats/unread-count'), { unread: 8 });
    assert.equal((await request(seller, '/notifications/counts')).chats, 8);
  });

  await t.test('declining contact exchange queues one email to the requester', async () => {
    const opened = await request(buyer, path + '/reveal', patch({ action: 'REQUEST' }));
    await request(seller, path + '/reveal', patch({ action: 'DECLINE', requestId: opened.revealRequestId }));
    await runJob('notifications.deliver');
    assert.equal((await notices(buyer, 'disclosure.declined')).length, 1);
    assert.equal(sent.filter(row => row.to === buyerUser.email && row.subject === 'Обмен контактами отклонён').length, 1);
  });

  await t.test('match notice has per-unit price, trust level and emails for both actions', async () => {
    await flag('feature_matching', true);
    const requestCard = await request(buyer, '/listings', post({
      title: 'Запрос для уведомления о совпадении', description: 'Тестовые параметры серверной конфигурации',
      categoryId: servers.id, kind: 'BUY', modelId: 'hgx-h200-8', destinationCountry: 'RU', originScope: 'ANY',
      deliveryBy: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), quantity: 1,
      priceMode: 'FIXED', price: 2000, currency: 'USD', paymentMethods: ['BANK_TRANSFER'],
    }));
    const offerFields = { quantity: 2, priceMode: 'FIXED', price: 1200, currency: 'USD', paymentMethods: ['BANK_TRANSFER'] };
    const firstOffer = await publish('Предложение совпадения первое', offerFields);
    const secondOffer = await publish('Предложение совпадения второе', offerFields);
    await db.query("UPDATE users SET trust_score=76,verification_level=1,verification_source='DOCUMENTS' WHERE id=$1",
      [sellerUser.id]);
    const { rows: matches } = await db.query(`
      INSERT INTO listing_matches(sell_listing_id,buy_listing_id,seller_id,buyer_id,type)
      SELECT id,$2,$3,$4,'FULL' FROM unnest($1::uuid[]) AS offer(id)
      ON CONFLICT (sell_listing_id,buy_listing_id) DO UPDATE SET buyer_notified_at=NULL,seller_notified_at=NULL
      RETURNING id
    `, [[firstOffer.id, secondOffer.id], requestCard.id, sellerUser.id, buyerUser.id]);
    assert.equal(matches.length, 2);
    await runJob('matching.notify');
    await runJob('notifications.deliver');
    const [matchNotice] = await notices(buyer, 'match.new');
    assert.match(matchNotice.body, /1200\.00 USD за шт\. \(2400\.00 USD за 2 шт\.\)/);
    assert.match(matchNotice.body, /Банковский перевод/);
    assert.match(matchNotice.body, /документы проверены, рейтинг 76 из 100/);
    assert.doesNotMatch(matchNotice.body, /пока нет/);
    assert.match(matchNotice.body, /\n\n/);
    const first = '/matches/' + matches[0].id;
    const second = '/matches/' + matches[1].id;
    await request(buyer, first + '/chat', post({}, 200));
    await request(buyer, second + '/decline', post({ reason: 'Цена не подходит' }, 200));
    assert.equal((await notices(seller, 'match.chat')).length, 1);
    assert.equal((await notices(seller, 'match.declined')).length, 1);
    await runJob('notifications.deliver');
    assert.ok(sent.some(row => row.to === sellerUser.email && row.subject === 'Открыт чат по совпадению'));
    assert.ok(sent.some(row => row.to === sellerUser.email && row.subject === 'Совпадение отклонено'));
    await flag('feature_matching', false);
  });

  await t.test('immediate staff notices, digest coalescing, opt-out exclusion and no staff quota', async () => {
    const nonce = randomBytes(3).toString('hex');
    const { rows: staff } = await db.query(`
      INSERT INTO users(username,display_name,email,password_hash,role,status,email_verified_at)
      VALUES ($1,'Модератор теста',$2,'synthetic','MODERATOR','ACTIVE',now()),
        ($3,'Недоступный модератор',$4,'synthetic','MODERATOR','FROZEN',now())
      RETURNING id,email,status
    `, ['staff-' + nonce, nonce + '@example.test', 'frozen-' + nonce, 'frozen-' + nonce + '@example.test']);
    await db.transaction(client => notifications.notifyStaff(client, {
      kind: 'onboarding.submitted', title: 'Анкета первого участника', body: 'Первый участник', dedupeKey: 'qa-staff-first',
    }));
    await runJob('notifications.deliver');
    const [active, frozen] = staff;
    const distinctRecipients = items => new Set(items.map(row => row.to));
    assert.deepEqual(distinctRecipients(sent.filter(row => row.subject === 'Анкета первого участника')),
      new Set([administrator.email, active.email]));
    await db.transaction(client => notifications.notifyStaff(client, {
      kind: 'onboarding.submitted', title: 'Анкета второго участника', body: 'Второй участник', dedupeKey: 'qa-staff-second',
    }));
    await runJob('notifications.deliver');
    assert.equal(sent.filter(row => row.subject === 'Анкета второго участника').length, 0);
    await db.query("UPDATE staff_notify_state SET last_email_at=now()-interval '11 minutes' WHERE kind='onboarding.submitted'");
    await runJob('chat.digest');
    await runJob('notifications.deliver');
    const bundle = sent.filter(row => row.subject === 'События для проверки: 2');
    assert.deepEqual(distinctRecipients(bundle), new Set([administrator.email, active.email]));
    assert.ok(bundle.every(row => row.body.includes('Первый участник') && row.body.includes('Второй участник')));
    assert.ok(!sent.some(row => row.to === frozen.email));

    await db.query("UPDATE users SET onboarding_state='DONE',onboarding_submitted_at=now() WHERE id=$1", [buyerUser.id]);
    const clock = await jobs.clock();
    await db.query("DELETE FROM job_runs WHERE job='staff.digest' AND slot=$1", [clock.day]);
    await runJob('staff.digest');
    await runJob('staff.digest');
    await runJob('notifications.deliver');
    const digest = sent.filter(row => row.subject === 'Сводка для модераторов');
    assert.deepEqual(distinctRecipients(digest), new Set([administrator.email, active.email]));
    assert.equal(digest.length, 2);
    assert.ok(digest.every(row => row.body.includes('анкеты 1')));
  });

  await t.test('urgent participant mail stays eligible, bulk delivery defers, staff are not capped', async () => {
    for (const user of [sellerUser, administrator]) {
      await db.query(`
        WITH existing AS (
          SELECT count(*)::int AS total
          FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
          JOIN platform_settings tz ON tz.key='timezone'
          WHERE n.user_id=$1 AND d.channel='EMAIL' AND d.status='SENT'
            AND (d.sent_at AT TIME ZONE (tz.value #>> '{}'))::date=(now() AT TIME ZONE (tz.value #>> '{}'))::date
        ), fixtures AS (
          INSERT INTO notifications(user_id,kind,title,body)
          SELECT $1,'qa.delivery','Фикстура','Фикстура' FROM existing,generate_series(1,$2::int-existing.total) RETURNING id
        )
        INSERT INTO notification_deliveries(notification_id,channel,status,sent_at)
        SELECT id,'EMAIL','SENT',now() FROM fixtures
      `, [user.id, user.role === 'ADMIN' ? 30 : 28]);
    }
    const notices = await db.transaction(async client => {
      const bulk = await notifications.notify(client, sellerUser.id, {
        kind: 'qa.bulk', title: 'Сводное письмо', body: 'Сводное письмо', channels: ['EMAIL'], priority: 3,
      });
      const urgent = await notifications.notify(client, sellerUser.id, {
        kind: 'qa.urgent', title: 'Срочное письмо', body: 'Срочное письмо', channels: ['EMAIL'], priority: 1,
      });
      const staff = await notifications.notify(client, administrator.id, {
        kind: 'qa.staff', title: 'Письмо сотруднику', body: 'Письмо сотруднику', channels: ['EMAIL'], priority: 3,
      });
      return { bulk, urgent, staff };
    });
    await runJob('notifications.deliver');
    const { rows } = await db.query(`
      SELECT notification_id,status,status='PENDING' AND next_attempt_at>now() AS deferred FROM notification_deliveries
      WHERE notification_id=ANY($1::bigint[]) ORDER BY notification_id
    `, [Object.values(notices)]);
    assert.deepEqual(rows, [
      { notification_id: notices.bulk, status: 'PENDING', deferred: true },
      { notification_id: notices.urgent, status: 'SENT', deferred: false },
      { notification_id: notices.staff, status: 'SENT', deferred: false },
    ]);
  });

  await t.test('one dated actualities notification aggregates multiple sweeps for one owner', async () => {
    await flag('feature_actuality', true);
    await db.query("UPDATE actuality_activation SET starts_at=now()-interval '1 day' WHERE singleton");
    const clock = await jobs.clock();
    const hidden = [];
    for (let i = 1; i <= 12; i++) {
      const row = await publish('Скрытие позиции ' + i);
      hidden.push(row.id);
    }
    const age = ids => db.query(`
      UPDATE listings SET asked_at=$2::timestamptz-interval '25 hours' WHERE id=ANY($1::uuid[])
    `, [ids, clock.now]);
    await age(hidden.slice(0, 8));
    await db.transaction(client => actualityJobs.sweep(client, clock));
    await age(hidden.slice(8));
    await db.transaction(client => actualityJobs.sweep(client, clock));
    const bulk = (await notices(seller, 'actuality.hidden')).filter(item => item.payload.listings.some(row => hidden.includes(row.id)));
    assert.equal(bulk.length, 1);
    assert.match(bulk[0].title, /Скрыто без ответа: 12/);
    assert.equal(bulk[0].payload.count, 12);
    const { rows: deliveries } = await db.query("SELECT channel FROM notification_deliveries WHERE notification_id=$1", [bulk[0].id]);
    assert.deepEqual(deliveries, [{ channel: 'EMAIL' }]);
  });
});
