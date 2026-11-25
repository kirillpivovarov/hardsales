import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const api = process.env.HWFORAI_ACTUALITY_TEST_URL?.replace(/\/$/, '');
const databaseUrl = process.env.HWFORAI_ACTUALITY_TEST_DATABASE_URL;
const mailpit = process.env.HWFORAI_ACTUALITY_TEST_MAILPIT_URL?.replace(/\/$/, '');
const configured = !!(api && databaseUrl);
const sellerId = '00000000-0000-4000-8000-000000000001';
const buyerId = '00000000-0000-4000-8000-000000000002';
const listings = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8110-00000000000${index + 1}`);
const dayMs = 24 * 60 * 60 * 1000;
const timezone = 'Europe/Moscow';

async function call(path, { method = 'GET', body, cookie, status = 200 } = {}) {
  const response = await fetch(api + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, method + ' ' + path + ' ' + JSON.stringify(payload));
  return { payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('actuality lifecycle with real PostgreSQL, API, daily job slots and one-use action links', {
  skip: !configured && 'Requires a disposable demo without EXCHANGE_DEMO_FEATURES, Nest, and its PostgreSQL database',
}, async t => {
  process.env.DATABASE_URL = databaseUrl;
  const { DatabaseService } = require('../dist/database/database.service.js');
  const { PlatformSettings } = require('../dist/exchange/platform-settings.js');
  const { ExchangeJobs } = require('../dist/exchange/jobs.js');
  const { ExchangeActions } = require('../dist/exchange/actions.js');
  const { ExchangeNotifications } = require('../dist/exchange/notifications.js');
  const { ActualityService } = require('../dist/exchange/actuality.service.js');
  const { ActualityJobs } = require('../dist/exchange/actuality.jobs.js');
  const { MailService } = require('../dist/auth/mail.service.js');
  const db = new DatabaseService();
  t.after(() => db.onApplicationShutdown());
  const settings = new PlatformSettings(db);
  const jobs = new ExchangeJobs(db, settings);
  const actions = new ExchangeActions(db);
  const notifications = new ExchangeNotifications(db, jobs, mailpit ? new MailService() : null);
  if (mailpit) notifications.onModuleInit();
  const noTrust = { refresh: async () => undefined };
  const worker = new ActualityJobs(jobs, new ActualityService(db, settings, actions, null, noTrust, notifications), notifications, actions, noTrust);
  worker.onModuleInit();
  const { now, day } = await jobs.clock();
  let clock = { now, day, hour: 10, timezone };
  jobs.clock = async () => clock;
  const seller = (await call('/auth/login', { method: 'POST', body: { login: 'test1', password: 'test1' } })).cookie;
  const buyer = (await call('/auth/login', { method: 'POST', body: { login: 'test2', password: 'test2' } })).cookie;
  assert.ok(seller && buyer);

  const summary = async () => (await call('/me/actuality', { cookie: seller })).payload;
  const listing = async (id, cookie = seller, status = 200) => (await call('/listings/' + id, { cookie, status })).payload;
  const answer = (id, body, status = 200) => call('/listings/' + id + '/actuality', { method: 'POST', body, cookie: seller, status });
  const resume = id => call('/listings/' + id + '/restore', { method: 'POST', cookie: seller });
  const query = (sql, input = []) => db.query(sql, input);
  const feature = value => query("UPDATE platform_settings SET value = $1::jsonb WHERE key = 'feature_actuality'", [String(value)]);
  const { rows: [fixtures] } = await query("SELECT count(*)::int AS count FROM users WHERE id = ANY($1::uuid[]) AND username IN ('test1','test2')", [[sellerId, buyerId]]);
  assert.equal(fixtures.count, 2, 'Use a disposable demo database');
  const sellerMailbox = `actuality-qa-${process.pid}@example.test`;
  if (mailpit) await query('UPDATE users SET email = $2 WHERE id = $1', [sellerId, sellerMailbox]);
  await feature(false);

  await t.test('disabled mode ignores expiry but stores listing lifetime', async () => {
    assert.equal((await summary()).enabled, false);
    assert.equal((await jobs.runNow('actuality.ask')).status, 'SKIPPED');
    await answer(listings[0], { answer: 'ACTUAL' }, 404);
    const { payload: categories } = await call('/categories');
    const { payload: created } = await call('/listings', {
      method: 'POST', cookie: seller, status: 201, body: {
        categoryId: categories.find(category => category.slug === 'gpu').id,
        title: 'Проверка хранения срока',
        description: 'Проверка срока без активации ежедневных запросов.',
        priceMode: 'FIXED', price: 150000, condition: 'NEW', quantity: 1,
        availability: 'STOCK', originScope: 'COUNTRY', originCountry: 'RU', stockCity: 'Новосибирск',
        lifetimeDays: 9,
      },
    });
    assert.equal(created.lifetimeDays, 9);
    assert.equal(created.expiresAt, null);
    await call('/listings/' + created.id, { method: 'DELETE', cookie: seller });
    await query("UPDATE listings SET expires_at = now() - interval '1 minute' WHERE id = $1", [listings[0]]);
    await listing(listings[0], buyer);
    await query("UPDATE listings SET expires_at = now() + interval '14 days' WHERE id = $1", [listings[0]]);
  });

  await t.test('catch-up ask is grouped and runs once, reminder independently deduplicates', async () => {
    await feature(true);
    clock = { ...clock, hour: 13 };
    await query("DELETE FROM job_runs WHERE job IN ('actuality.ask','actuality.remind') AND slot = $1", [day]);
    assert.equal((await jobs.runNow('actuality.ask')).status, 'DONE');
    assert.equal((await jobs.runNow('actuality.ask')).status, 'DONE');
    const { rows } = await query("SELECT actions, payload FROM notifications WHERE user_id = $1 AND dedupe_key = $2", [
      sellerId, `actuality.ask:${sellerId}:${day}`,
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.listingIds.length, 8);
    assert.equal((await summary()).pending.length, 8);
    assert.equal((await listing(listings[0], buyer)).askedAt, null);
    assert.ok((await listing(listings[0], buyer)).freshness);
    if (mailpit) {
      await jobs.runNow('notifications.deliver');
      const mailbox = await (await fetch(mailpit + '/api/v1/messages')).json();
      const envelopes = mailbox.messages.filter(item => item.Subject === 'Актуально?' &&
        item.To.some(recipient => recipient.Address === sellerMailbox));
      assert.equal(envelopes.length, 1);
    }
    clock = { ...clock, now: new Date(now.getTime() + 6 * 60 * 60 * 1000), hour: 16 };
    assert.equal((await jobs.runNow('actuality.remind')).status, 'DONE');
    assert.equal((await jobs.runNow('actuality.remind')).status, 'DONE');
    const { rows: [count] } = await query("SELECT count(*)::int AS total FROM notifications WHERE user_id = $1 AND dedupe_key = $2", [
      sellerId, `actuality.remind:${sellerId}:${day}`,
    ]);
    assert.equal(count.total, 1);
    clock = { ...clock, now };
  });

  await t.test('scanner GET is read-only, CHANGED updates history and action token is one-use', async () => {
    await query('UPDATE listings SET min_lot = 2 WHERE id = $1', [listings[0]]);
    const { rows: [row] } = await query("SELECT actions FROM notifications WHERE user_id = $1 AND dedupe_key = $2", [
      sellerId, `actuality.ask:${sellerId}:${day}`,
    ]);
    const current = await listing(listings[0]);
    const action = row.actions.find(entry => entry.action === 'listing.actuality' && entry.label.includes(current.title));
    const route = '/actions/' + action.token;
    const { payload: description } = await call(route);
    assert.equal(description.purpose, 'listing.actuality');
    assert.equal(description.fields.minLot, 2);
    assert.equal((await listing(listings[0])).askedAt, current.askedAt);
    await call(route, { method: 'POST', body: { answer: 'CHANGED', quantity: 1 }, status: 400 });
    const { payload: changed } = await call(route, {
      method: 'POST', body: { answer: 'CHANGED', price: current.price - 1 },
    });
    assert.equal(changed.askedAt, null);
    assert.equal(changed.priceChanges14, 1);
    await call(route, { method: 'POST', body: { answer: 'ACTUAL' }, status: 409 });
    assert.equal((await answer(listings[0], { answer: 'ACTUAL' })).payload.confirmedAt, changed.confirmedAt);
    const { rows: [record] } = await query(`
      SELECT a.answer, a.on_time, h.source FROM listing_actuality_asks a JOIN listing_price_history h ON h.listing_id = a.listing_id
      WHERE a.listing_id = $1 AND a.local_date = $2 AND h.source = 'ACTUALITY'
    `, [listings[0], day]);
    assert.deepEqual(record, { answer: 'CHANGED', on_time: true, source: 'ACTUALITY' });
  });

  await t.test('pause hides listings, answers open questions and auto-resumes', async () => {
    const { payload: { pause } } = await call('/me/pause', { method: 'POST', status: 201, cookie: seller, body: { days: 2 } });
    assert.equal((await listing(listings[1])).hiddenReason, 'PAUSE');
    await listing(listings[1], buyer, 404);
    await call('/listings/' + listings[1], { method: 'PATCH', cookie: seller, body: {}, status: 409 });
    assert.equal((await summary()).pending.length, 0);
    const { rows: [record] } = await query("SELECT answer,on_time FROM listing_actuality_asks WHERE listing_id = $1 AND local_date = $2", [listings[1], day]);
    assert.deepEqual(record, { answer: 'PAUSE', on_time: true });
    clock = { ...clock, now: new Date(new Date(pause.endsAt).getTime() + 5000) };
    await db.transaction(client => worker.sweep(client, clock));
    assert.equal((await listing(listings[1])).status, 'ACTIVE');
    assert.equal((await summary()).pause, null);
    clock = { ...clock, now };
    await call('/me/pause', { method: 'POST', cookie: seller, body: { days: 11 }, status: 409 });
  });

  await t.test('distinct missed dates suspend after the third date, and self-resume restores', async () => {
    const { payload: chat } = await call('/chats', {
      method: 'POST', cookie: buyer, body: { listingId: listings[3] }, status: 201,
    });
    await query(`
      INSERT INTO listing_actuality_asks (listing_id, owner_id, local_date, asked_at, missed_at, on_time)
      VALUES ($1,$5,$6::date-5,$7::timestamptz-interval '5 days',$7::timestamptz-interval '4 days',false),
             ($2,$5,$6::date-5,$7::timestamptz-interval '5 days',$7::timestamptz-interval '4 days',false),
             ($3,$5,$6::date-4,$7::timestamptz-interval '4 days',$7::timestamptz-interval '3 days',false),
             ($4,$5,$6::date-2,$7::timestamptz-interval '2 days',NULL,NULL)
    `, [listings[0], listings[1], listings[2], listings[3], sellerId, day, now]);
    await query("UPDATE listings SET asked_at = $2::timestamptz - interval '2 days' WHERE id = $1", [listings[3], now]);
    assert.equal((await summary()).missedDays30, 2);
    await db.transaction(client => worker.sweep(client, clock));
    const state = await summary();
    assert.equal(state.missedDays30, 3);
    assert.equal(state.suspended, true);
    assert.equal((await listing(listings[3])).hiddenReason, 'MISSED3');
    await listing(listings[0], buyer, 404);
    assert.equal((await call('/chats/' + chat.id, { cookie: buyer })).payload.id, chat.id);
    const { rows: [notice] } = await query(
      "SELECT payload FROM notifications WHERE user_id = $1 AND kind = 'actuality.chat_hidden' AND payload->>'chatId' = $2",
      [buyerId, chat.id],
    );
    assert.equal(notice?.payload.listingId, listings[3]);
    const { payload } = await call('/me/actuality/resume', { method:'POST', cookie: seller });
    assert.equal(payload.restored, 8);
    assert.equal((await summary()).suspended, false);
    await listing(listings[0], buyer);
  });

  await t.test('hidden recovery, seven-day archival and expiry remain separate', async () => {
    const [first, second, third] = listings.slice(-3);
    await query(`
      UPDATE listings SET status = 'HIDDEN', hidden_reason = 'NO_ANSWER', hidden_at = $2::timestamptz - interval '6 days'
      WHERE id = $1
    `, [first, now]);
    await listing(first, buyer, 404);
    assert.equal((await resume(first)).payload.status, 'ACTIVE');
    await query(`
      UPDATE listings SET status = 'HIDDEN',hidden_reason = 'NO_ANSWER', hidden_at = $2::timestamptz - interval '8 days'
      WHERE id = $1
    `, [second, now]);
    await query("UPDATE listings SET expires_at = $2::timestamptz - interval '1 minute' WHERE id = $1", [third, now]);
    await listing(third, buyer, 404);
    await db.transaction(client => worker.sweep(client, clock));
    assert.equal((await listing(second)).archivedReason, 'HIDDEN_7D');
    assert.equal((await listing(third)).archivedReason, 'EXPIRED');
    const reborn = (await resume(third)).payload;
    assert.equal(reborn.status, 'ACTIVE');
    assert.ok(new Date(reborn.expiresAt).getTime() > now.getTime() + 13 * dayMs);
  });

  const loginAdmin = async () => {
    const initial = await call('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin' } });
    return initial.payload.user.mustChangePassword ? await call('/auth/credentials', {
      method: 'PATCH', cookie: initial.cookie,
      body: { currentPassword: 'admin', newPassword: 'Private-Actuality-QA-Only!682' },
    }) : initial;
  };
  const admin = await loginAdmin();

  await t.test('spot-check hold survives expiry and only staff can republish it', async () => {
    const spotListing = listings[5];
    await query(`
      UPDATE listings SET status = 'HIDDEN', hidden_reason = 'SPOT_CHECK', hidden_at = $2,
        expires_at = $2::timestamptz - interval '1 minute' WHERE id = $1
    `, [spotListing, now]);
    await call('/listings/' + spotListing + '/restore', { method: 'POST', cookie: seller, status: 409 });
    await db.transaction(client => worker.sweep(client, clock));
    const archived = await listing(spotListing);
    assert.equal(archived.status, 'ARCHIVED');
    assert.equal(archived.spotCheckHold, true);
    await call('/listings/' + spotListing + '/restore', { method: 'POST', cookie: seller, status: 409 });
    await listing(spotListing, buyer, 404);
    await call('/admin/listings/' + spotListing + '/status', {
      method: 'PATCH', cookie: admin.cookie, body: { status: 'ACTIVE', reason: 'Объявление проверено вручную' },
    });
    const published = await listing(spotListing, buyer);
    assert.equal(published.status, 'ACTIVE');
    assert.ok(new Date(published.expiresAt).getTime() > now.getTime() + 13 * dayMs);
    assert.equal((await listing(spotListing)).spotCheckHold, false);
  });

  await feature(false);
  await t.test('administrator schedules the first ask after an announced three-day notice', async () => {
    const before = Date.now();
    await call('/admin/settings/feature_actuality', { method: 'PUT', cookie: admin.cookie, body: { value: true } });
    const state = await summary();
    assert.equal(state.enabled, false);
    assert.ok(new Date(state.startsAt).getTime() - before >= 3 * dayMs - 1000);
    assert.equal(new Intl.DateTimeFormat('ru', { timeZone: timezone, hour: '2-digit' }).format(new Date(state.startsAt)), '10');
    assert.equal((await jobs.runNow('actuality.ask')).status, 'SKIPPED');
    const { rows: [notice] } = await query(`
      SELECT n.payload, d.channel FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id
      WHERE n.user_id = $1 AND n.kind = 'actuality.announced'
    `, [sellerId]);
    assert.equal(notice.payload.startsAt, state.startsAt);
    assert.equal(notice.channel, 'EMAIL');
    await feature(false);
  });
});
