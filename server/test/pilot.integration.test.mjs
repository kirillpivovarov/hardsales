import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { DatabaseService } = require('../dist/database/database.service.js');
const { ExchangeJobs } = require('../dist/exchange/jobs.js');
const { ExchangeNotifications } = require('../dist/exchange/notifications.js');
const { DealsService } = require('../dist/exchange/deals.service.js');
const { PlatformSettings } = require('../dist/exchange/platform-settings.js');
const { PilotService, pilotCsv } = require('../dist/pilot/pilot.service.js');
const { pilotPeriod, validatePilotSetting } = require('../dist/pilot/pilot.settings.js');

const databaseUrl = process.env.HWFORAI_PILOT_TEST_DATABASE_URL;
const demo = '00000000-0000-4000-8000-000000000001';
const dates = { from: '2026-11-26', to: '2026-11-27' };
const didNotMatch = { status: 400 };

test('pilot dates validate calendar days and limit the inclusive range', async () => {
  assert.deepEqual(pilotPeriod('2024-02-29', '2024-02-29'), { from: '2024-02-29', to: '2024-02-29' });
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-03-01', '2026-02-28'], ['2025-01-01', '2026-01-02']]) {
    assert.throws(() => pilotPeriod(from, to), didNotMatch);
  }
  await assert.rejects(validatePilotSetting(null, 'pilot_excluded_users', ['wrong']), didNotMatch);
  await assert.rejects(validatePilotSetting(null, 'pilot_targets', { onTimeShare: 1.1 }), didNotMatch);
});

async function seed(db) {
  async function user(role, nickname, { id = randomUUID(), level = 0 } = {}) {
    await db.query(`INSERT INTO users (id,username,display_name,email,password_hash,role,participant_type,city,country,telegram,
      email_verified_at,verification_level,created_at) VALUES ($1,$2,$2,$2||'@example.test','test-fixture',$3,'INDIVIDUAL',
      'Казань','RU',$2,now(),$4,'2026-11-26 10:00:00+00')`, [id, nickname, role, level]);
    return id;
  }
  const seller = await user('SELLER', 'pilot-seller', { level: 2 });
  const excluded = await user('SELLER', 'pilot-excluded');
  await user('SELLER', 'pilot-demo', { id: demo });
  const admin = await user('ADMIN', 'pilot-administrator');
  const buyers = [];
  for (let index = 0; index < 4; index++) buyers.push(await user('BUYER', `pilot-buyer${index}`, { level: index ? 0 : 1 }));
  await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='pilot_excluded_users'", [JSON.stringify([excluded])]);

  async function listing(owner, kind) {
    const { rows: [row] } = await db.query(`INSERT INTO listings (owner_id,category_id,kind,title,description,quantity,
      condition,price_mode,currency,availability,origin_scope,origin_country,destination_country,stock_city,delivery_by,vat,counterparty)
      SELECT $1,id,$2,'Предмет пробы','Описание для сценария пробы',1,'NEW','NEGOTIABLE','RUB',
        CASE WHEN $2='SELL' THEN 'STOCK' END,CASE WHEN $2='BUY' THEN 'ANY' END,
        'RU','RU',CASE WHEN $2='SELL' THEN 'Казань' END,CURRENT_DATE+30,'NA','ANY'
      FROM categories WHERE slug='gpu' RETURNING id`, [owner, kind]);
    return row.id;
  }
  async function pair(owner, buyer, { index, operator = false, status = 'CHAT' }) {
    const sell = await listing(owner, 'SELL');
    const buy = await listing(buyer, 'BUY');
    const { rows: [chat] } = await db.query('INSERT INTO chats(listing_id,owner_id,visitor_id) VALUES ($1,$2,$3) RETURNING id', [sell, owner, buyer]);
    const created = index === 0 ? '2026-11-26 20:00:00+00' : '2026-11-26 19:00:00+00';
    const { rows: [match] } = await db.query(`INSERT INTO listing_matches (sell_listing_id,buy_listing_id,seller_id,buyer_id,
      chat_id,source,type,status,created_at,proposed_at,proposed_by,operator_comment,operator_failures)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $6='OPERATOR' THEN $9::timestamptz END,
        CASE WHEN $6='OPERATOR' THEN $10::uuid END,CASE WHEN $6='OPERATOR' THEN 'Подходит условие оператора' END,
        CASE WHEN $6='OPERATOR' THEN '[]'::jsonb END) RETURNING id`,
    [sell, buy, owner, buyer, chat.id, operator ? 'OPERATOR' : 'SYSTEM', operator ? 'PARTIAL' : 'FULL', status, created, admin]);
    await db.query(`INSERT INTO chat_messages (chat_id,sender_id,body,created_at) VALUES
      ($1,$2,'Запрос продавца',$4),($1,$3,'Ответ покупателя',$5)`, [chat.id, owner, buyer,
      index === 2 ? '2026-11-26 18:59:00+00' : '2026-11-26 20:09:00+00',
      index === 0 ? '2026-11-26 21:00:00+00' : '2026-11-26 20:30:00+00']);
    return { sell, buy, chat: chat.id, match: match.id, owner, buyer };
  }
  const first = await pair(seller, buyers[0], { index: 0, status: 'VOID' });
  const second = await pair(seller, buyers[1], { index: 1, operator: true });
  const third = await pair(seller, buyers[2], { index: 2 });
  await pair(excluded, buyers[0], { index: 3 });
  await pair(demo, buyers[0], { index: 3 });
  const fourthChat = (await db.query('INSERT INTO chats(listing_id,owner_id,visitor_id) VALUES ($1,$2,$3) RETURNING id',
    [first.sell, seller, buyers[3]])).rows[0].id;

  async function reveal(pair, kind = 'FIRST') {
    const [a, b] = [pair.owner, pair.buyer].sort();
    const { rows: [exchange] } = await db.query(`INSERT INTO chat_contact_exchanges (chat_id,requested_by,accepted_by)
      VALUES ($1,$2,$3) RETURNING id`, [pair.chat, a, b]);
    const { rows: [disclosure] } = await db.query(`INSERT INTO disclosures (user_a_id,user_b_id,exchange_id,chat_id,listing_id,
      kind,requested_by,accepted_by,accepted_at,listing_snapshot,party_a,party_b)
      VALUES ($1,$2,$3,$4,$5,$6,$1,$2,'2026-11-26 12:00:00+00','{}','{}','{}') RETURNING id`,
    [a, b, exchange.id, pair.chat, pair.sell, kind]);
    return disclosure.id;
  }
  const disclosure = await reveal(first);
  await reveal(second);
  await reveal(third);
  await reveal({ ...first, chat: fourthChat, buyer: buyers[3] });
  await reveal(first, 'REPEAT');
  await db.query(`INSERT INTO deals (disclosure_id,seller_id,buyer_id,status,seller_agreed,buyer_agreed,agreed_at)
    VALUES ($1,$2,$3,'EXECUTED','{"amount":1}','{"amount":1}','2026-11-26 13:00:00+00')`, [disclosure, seller, first.buyer]);

  for (let index = 0; index < 10; index++) {
    const id = await listing(seller, 'SELL');
    const answer = index === 6 ? 'PAUSE' : index < 8 ? 'ACTUAL' : null;
    await db.query(`INSERT INTO listing_actuality_asks (listing_id,owner_id,local_date,asked_at,answered_at,answer,on_time,missed_at)
      VALUES ($1,$2,'2026-11-26','2026-11-26 01:00:00+00',$3,$4,$5,$6)`, [id, seller,
      index < 8 ? '2026-11-26 13:00:00+00' : null, answer, index < 9 ? index < 7 : null,
      index === 8 ? '2026-11-27 01:00:00+00' : null]);
  }
  await db.query(`INSERT INTO invites (code,created_by,created_at,expires_at,used_by,used_at)
    VALUES ('K7QQ-M2XA',$1,'2026-11-26 01:00:00+00','2026-12-25',$2,'2026-11-27 01:00:00+00')`, [admin, buyers[0]]);
  await db.query("UPDATE listings SET status='HIDDEN',hidden_reason='NO_ANSWER',hidden_at=now() WHERE id=$1", [third.sell]);
  return { admin, seller, third };
}

test('pilot observes live responses, calendar cohorts, stop threshold and privacy on PostgreSQL', {
  skip: !databaseUrl && 'Set HWFORAI_PILOT_TEST_DATABASE_URL to a fresh disposable PostgreSQL database',
}, async t => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DEMO_MODE = 'true';
  const db = new DatabaseService();
  t.after(() => db.onApplicationShutdown());
  await db.migrate();
  const { rows: [existing] } = await db.query('SELECT count(*)::int AS count FROM users');
  assert.equal(existing.count, 0, 'Use a fresh disposable database');
  const { admin, seller, third } = await seed(db);
  const settings = new PlatformSettings(db);
  const jobs = new ExchangeJobs(db, settings);
  let clock = { now: new Date('2026-11-27T09:00:00Z'), day: '2026-11-27', timezone: 'Europe/Moscow', hour: 12 };
  jobs.clock = async () => clock;
  const pilot = new PilotService(db, settings, jobs, new ExchangeNotifications(db, jobs, null));
  pilot.onModuleInit();

  const report = await pilot.metrics(dates);
  assert.deepEqual(report.totals.matches, { total: 3, full: 2, partial: 1, system: 2, operator: 1 });
  assert.equal(report.totals.liveMatches, 2);
  assert.equal(report.totals.disclosures, 4);
  assert.equal(report.totals.disclosuresToAgreedShare, .25);
  assert.equal(report.totals.dealsExecuted, 1);
  assert.equal(report.totals.onTimeShare, 7 / 9);
  assert.deepEqual(report.totals.participants, { level0: 3, level1: 1, level2: 1, registered: 5, invitesIssued: 1, invitesUsed: 1 });
  assert.deepEqual(report.days.map(day => [day.date, day.snapshot, day.liveMatches, day.confirmed, day.hidden]), [
    ['2026-11-26', 'MISSING', 1, 7, null], ['2026-11-27', 'LIVE', 1, 0, 1],
  ]);
  assert.equal(report.stopRule.state, 'WARNING');
  assert.equal(await pilot.metrics(dates), report, 'same date range within TTL is cached');
  assert.equal((await pilot.metrics({ from: '2026-11-27', to: '2026-11-27' })).totals.onTimeShare, null);
  const csv = pilotCsv(report.days);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /2026-11-26;7;;;;3;1;1;4;1;9;7;0,78\r\n/);
  assert.doesNotMatch(csv + JSON.stringify(report), /pilot-seller|example\.test|00000000-0000/);
  assert.ok(!(csv + JSON.stringify(report)).includes(seller));

  await assert.rejects(db.transaction(client => validatePilotSetting(client, 'stop_rule',
    { date: '2026-11-24', minLiveMatches: 3 })), didNotMatch);
  await assert.rejects(db.transaction(client => validatePilotSetting(client, 'stop_rule',
    { date: '2026-12-08', minLiveMatches: 0 })), didNotMatch);

  clock = { ...clock, now: new Date('2026-12-08T06:00:00Z'), day: '2026-12-08', hour: 9 };
  assert.equal((await pilot.metrics(dates)).stopRule.state, 'TRIGGERED');
  assert.equal((await jobs.runNow('pilot.snapshot')).status, 'DONE');
  await jobs.runNow('pilot.snapshot');
  const snapshots = await db.query('SELECT local_date::text,late FROM pilot_daily_snapshots');
  assert.deepEqual(snapshots.rows, [{ local_date: '2026-12-07', late: true }]);
  assert.equal((await jobs.runNow('pilot.stop-rule')).status, 'DONE');
  await jobs.runNow('pilot.stop-rule');
  const notices = await db.query(`SELECT n.dedupe_key,d.channel FROM notifications n JOIN notification_deliveries d
    ON d.notification_id=n.id WHERE n.user_id=$1`, [admin]);
  assert.deepEqual(notices.rows, [{ dedupe_key: 'pilot.stop-rule:2026-12-08', channel: 'EMAIL' }]);

  await db.query(`INSERT INTO chat_messages (chat_id,sender_id,body,created_at)
    VALUES ($1,$2,'Уточнил предложение','2026-12-08 20:59:59+00')`, [third.chat, seller]);
  clock = { ...clock, now: new Date('2026-12-08T21:00:00Z'), day: '2026-12-09', hour: 0 };
  const reached = await pilot.metrics(dates);
  assert.equal(reached.stopRule.state, 'PASSED');
  assert.equal(reached.stopRule.liveMatches, 3);
  assert.equal(reached.totals.liveMatches, 2);

  await t.test('records the first bilateral agreement once', async () => {
    const { rows: [deal] } = await db.query(`
      INSERT INTO deals(disclosure_id,seller_id,buyer_id)
      SELECT s.id,$1,CASE WHEN s.user_a_id=$1 THEN s.user_b_id ELSE s.user_a_id END
      FROM disclosures s WHERE $1 IN (s.user_a_id,s.user_b_id)
        AND s.kind='FIRST' AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.disclosure_id=s.id)
      ORDER BY s.number LIMIT 1 RETURNING id,buyer_id
    `, [seller]);
    const notifications = new ExchangeNotifications(db, jobs, null);
    const deals = new DealsService(db, jobs, settings, notifications, { requireEnabled: async () => {} });
    const terms = { status: 'AGREED', amount: 100, quantity: 1, currency: 'RUB' };
    const one = await deals.changeStatus(seller, deal.id, terms);
    assert.equal(one.status, 'NEGOTIATING');
    assert.equal(one.agreedAt, null);
    const two = await deals.changeStatus(deal.buyer_id, deal.id, terms);
    assert.equal(two.status, 'AGREED');
    assert.ok(two.agreedAt instanceof Date);
    const updated = await deals.changeStatus(deal.buyer_id, deal.id, { ...terms, amount: 110 });
    assert.equal(updated.agreedAt.toISOString(), two.agreedAt.toISOString());
  });
});
