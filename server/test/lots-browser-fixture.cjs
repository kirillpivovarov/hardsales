const { randomBytes } = require('node:crypto');
const { DatabaseService } = require('../dist/database/database.service.js');
const { ExchangeJobs } = require('../dist/exchange/jobs.js');
const { ExchangeNotifications } = require('../dist/exchange/notifications.js');
const { PlatformSettings } = require('../dist/exchange/platform-settings.js');
const { LotDetection } = require('../dist/lots/lot-detection.js');
const { hashToken } = require('../dist/auth/auth.crypto.js');

const database = process.env.HWFORAI_LOTS_TEST_DATABASE_URL;
const databaseName = database ? new URL(database).pathname.slice(1) : '';
if (!/^(?:maxv_baseline_|hwforai_lots_ui_)[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error('Use a disposable maxv_baseline_* or hwforai_lots_ui_* test database');
}
process.env.DATABASE_URL = database;
const db = new DatabaseService();

async function fixture() {
  const settings = new PlatformSettings(db);
  const jobs = new ExchangeJobs(db, settings);
  const detector = new LotDetection(jobs, settings, new ExchangeNotifications(db, jobs, {}));
  detector.onModuleInit();
  const tag = randomBytes(5).toString('hex').replace(/\d/g, digit => 'ghijklmnop'[Number(digit)]);
  const query = 'Кластер склейки ' + tag;
  const primaryTitle = query + ' главный';
  const alternativeTitle = query + ' альтернативный';
  const alternativeName = 'Другой поставщик';
  const tokens = {};
  const users = {};
  await db.transaction(async client => {
    const { rows: [demo] } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE id='00000000-0000-4000-8000-000000000002' AND username='test2'
      ) AS ready
    `);
    if (!demo.ready) throw new Error('Start a disposable maxv demo with seeded users');
    const policyVersion = await settings.get('pd_policy_version', client);
    for (const [key, role, nickname] of [
      ['buyer', 'BUYER', 'Проверка покупателя'],
      ['seller', 'SELLER', 'Проверка продавца'],
      ['other', 'SELLER', alternativeName],
      ['moderator', 'MODERATOR', 'Проверка модерации'],
    ]) {
      const username = 'lot-' + key + '-' + tag;
      const participant = role !== 'MODERATOR';
      const { rows: [user] } = await client.query(`
        INSERT INTO users(username,display_name,email,password_hash,role,participant_type,city,country,telegram,
          email_verified_at,pd_consent_version,pd_consent_at)
        VALUES ($1,$2,$1 || '@example.test','disabled-browser-fixture',$3,$4,$5,$6,$7,now(),$8,now())
        RETURNING id
      `, [username, nickname, role, participant ? 'INDIVIDUAL' : null, participant ? 'Москва' : null,
        participant ? 'RU' : null, participant ? username.replaceAll('-', '_') : null, policyVersion]);
      users[key] = user.id;
      if (key !== 'other') {
        tokens[key] = randomBytes(32).toString('hex');
        await client.query(`
          INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')
        `, [user.id, hashToken(tokens[key])]);
      }
    }
    const { rows } = await client.query(`
      INSERT INTO listings(owner_id,category_id,kind,title,description,quantity,condition,price_mode,price,currency,
        availability,origin_scope,origin_country,stock_city,vat,counterparty,model_id,trust_score)
      SELECT f.owner,c.id,'SELL',f.title,'Проверка склейки одинаковых лотов на складе.',16,'NEW','FIXED',f.price,'USD',
        'STOCK','COUNTRY','HK','Гонконг ' || $5,'NA','ANY','hgx-h200-8',f.rating
      FROM categories c CROSS JOIN (VALUES ($1::uuid,$3::text,1000000,75),
        ($2::uuid,$4::text,1040000,65)) f(owner,title,price,rating) WHERE c.slug='servers'
      RETURNING id,title
    `, [users.seller, users.other, primaryTitle, alternativeTitle, tag]);
    users.primaryListingId = rows.find(row => row.title === primaryTitle).id;
    users.alternativeListingId = rows.find(row => row.title === alternativeTitle).id;
    await client.query(`
      UPDATE platform_settings SET value=to_jsonb(key='feature_lot_groups')
      WHERE key IN ('feature_lot_groups', 'feature_trust_rating')
    `);
  });
  const run = await jobs.runNow('lots.detect', 'browser:' + tag);
  if (run.status !== 'DONE') throw new Error('Lot detection did not complete');
  const { rows: [group] } = await db.query(`
    SELECT g.id FROM lot_groups g JOIN lot_group_members m ON m.group_id=g.id WHERE m.listing_id=$1
  `, [users.primaryListingId]);
  if (!group) throw new Error('No lot group created');
  return { tokens, lotId: group.id, query, primaryTitle, alternativeTitle,
    alternativeListingId: users.alternativeListingId, alternativeName };
}

fixture().then(value => process.stdout.write(JSON.stringify(value))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => db.onApplicationShutdown());
