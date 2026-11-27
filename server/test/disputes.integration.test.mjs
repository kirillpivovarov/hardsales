import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.HWFORAI_DISPUTES_TEST_DATABASE_URL;
const api = process.env.HWFORAI_DISPUTES_TEST_URL?.replace(/\/$/, '');
const digest = value => createHash('sha256').update(value).digest('hex');

const initial = {
  kind: 'MISREPRESENTATION',
  essence: 'Количество в отправленном счёте отличается от согласованного количества.',
  demand: 'Прошу проверить условия сделки.',
};
const decision = (penalty, loserId = null) => ({
  penalty, loserId, rationale: 'Материалы рассмотрены, решение принято после проверки пояснений обеих сторон.',
});
const further = { text: 'Получено уточнение по количеству, оно приложено отдельным файлом.' };

async function call(path, { actor, method = 'GET', body, status = 200 } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(actor ? { Cookie: 'hwforai_session=' + actor.token } : {}),
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, method + ' ' + path + ': ' + await response.clone().text());
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}

async function send(path, actor, body = {}, status = 201) {
  return call(path, { actor, method: 'POST', body, status });
}

async function set(db, key, value) {
  assert.equal((await db.query('UPDATE platform_settings SET value=$2::jsonb WHERE key=$1', [key, JSON.stringify(value)])).rowCount, 1);
}

async function fixture(db) {
  const slice = randomBytes(4).toString('hex');
  async function session(id, email) {
    const token = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
      VALUES ($1,$2,now()+interval '90 minutes')`, [id, digest(token)]);
    return { id, token, email };
  }
  async function user(role, key) {
    const username = 'dispute-' + key + '-' + slice;
    const email = username + '@example.test';
    const { rows: [row] } = await db.query(`
      INSERT INTO users(username,display_name,email,password_hash,role,participant_type,city,country,telegram,email_verified_at,
        pd_consent_version,pd_consent_at,onboarding_state)
      VALUES($1,$1,$2,'fixture-only',$3,CASE WHEN $3='MODERATOR' THEN NULL ELSE 'INDIVIDUAL' END,
        'Пермь','RU',$4,now(),(SELECT value #>> '{}' FROM platform_settings WHERE key='pd_policy_version'),now(),'EXEMPT')
      RETURNING id
    `, [username, email, role, 'dispute_' + key + '_' + slice]);
    return session(row.id, email);
  }
  const { rows: [owner] } = await db.query(`
    UPDATE users SET must_change_password=false WHERE username='admin' AND role='ADMIN'
    RETURNING id,email
  `);
  assert.ok(owner, 'the test only mutates a disposable demo with its initial administrator');
  const admin = await session(owner.id, owner.email);
  const staff = await user('MODERATOR', 'staff');
  const seller = await user('SELLER', 'seller');
  const buyer = await user('BUYER', 'buyer');
  const other = await user('BUYER', 'other');

  async function pair(visitor = buyer, vendor = seller) {
    const { rows: [listing] } = await db.query(`
      INSERT INTO listings(owner_id,category_id,kind,title,description,quantity,condition,price_mode,currency,availability,
        origin_scope,origin_country,stock_city,vat,counterparty,model_id)
      SELECT $1,id,'SELL','NVIDIA H100 для проверки споров','Складское оборудование для проверки процедуры спора.',
        8,'NEW','NEGOTIABLE','RUB','STOCK','COUNTRY','RU','Пермь','NA','ANY','h100-sxm'
      FROM categories WHERE slug='gpu' RETURNING id`, [vendor.id]);
    const { rows: [chat] } = await db.query(`
      INSERT INTO chats(listing_id,owner_id,visitor_id) VALUES($1,$2,$3) RETURNING id
    `, [listing.id, vendor.id, visitor.id]);
    const { rows: [exchange] } = await db.query(`
      INSERT INTO chat_contact_exchanges(chat_id,requested_by,accepted_by) VALUES($1,$2,$3) RETURNING id
    `, [chat.id, visitor.id, vendor.id]);
    const parties = [visitor.id,vendor.id].sort();
    const { rows: [disclosure] } = await db.query(`
      INSERT INTO disclosures(user_a_id,user_b_id,exchange_id,chat_id,listing_id,kind,requested_by,accepted_by,accepted_at,
        listing_snapshot,party_a,party_b)
      VALUES($1,$2,$3,$4,$5,'FIRST',$6,$7,now(),
        '{"title":"NVIDIA H100"}','{"country":"RU","nickname":"Первый участник"}','{"country":"RU","nickname":"Второй участник"}')
      RETURNING id
    `, [...parties, exchange.id, chat.id, listing.id, visitor.id, vendor.id]);
    const { rows: [deal] } = await db.query(`
      INSERT INTO deals(disclosure_id,seller_id,buyer_id,sell_listing_id)
      VALUES($1,$2,$3,$4) RETURNING id
    `, [disclosure.id, vendor.id, visitor.id, listing.id]);
    return { disclosure: disclosure.id, listing: listing.id, chat: chat.id, deal: deal.id };
  }
  return { admin, staff, seller, buyer, other, pair };
}

function material(note, file, name = 'Переписка.txt', questionId) {
  const body = new FormData();
  body.set('data', JSON.stringify({ note, ...(questionId ? { questionId } : {}) }));
  if (file) body.set('file', file, name);
  return body;
}

test('a dispute runs through notification, evidence, decision and one reconsideration per party', async t => {
  assert.ok(api && databaseUrl, 'Set HWFORAI_DISPUTES_TEST_URL and HWFORAI_DISPUTES_TEST_DATABASE_URL to a disposable local demo');
  assert.match(new URL(api).hostname, /^(127\.0\.0\.1|localhost)$/);
  assert.match(new URL(databaseUrl).pathname, /^\/(?:maxv_baseline_|hwforai_disputes_)/);
  const db = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  const { admin, staff, seller, buyer, other, pair } = await fixture(db);
  const original = await pair();
  const unrelated = await pair(other);
  const path = id => '/disputes/' + id;
  const manage = id => '/admin/disputes/' + id;
  await set(db, 'feature_trust_rating', true);
  await set(db, 'feature_disputes', false);

  const report = await db.query(`
    INSERT INTO reports(chat_id,reporter_id,subject_id,reason,scope,status,details)
    VALUES($1,$2,$3,'FRAUD','ON_PLATFORM','RESOLVED','Историческая жалоба в чате') RETURNING id
  `, [original.chat, buyer.id, seller.id]);
  await db.query(`
    INSERT INTO moderation_audit(actor,entity,entity_id,action,after_data)
    VALUES('admin','reports',$1,'status-changed','{"status":"RESOLVED"}')
  `, [report.rows[0].id]);
  const disputePoints = async () => (await call('/me/trust', { actor: seller })).factors.find(factor => factor.id === 'disputes').value;
  assert.equal(await disputePoints(), 5);
  await call('/disputes', { actor: buyer, status: 404 });
  await set(db, 'feature_disputes', true);
  assert.equal(await disputePoints(), 10);
  let opened;
  let proof;
  let ownProof;

  await t.test('starts only for a disclosed party and computes a working-day deadline', async () => {
    await send('/disputes', other, { ...initial, disclosureId: original.disclosure }, 403);
    await send('/disputes', buyer, { ...initial, disclosureId: original.disclosure, dealId: unrelated.deal }, 400);
    await send('/disputes', buyer, { ...initial, disclosureId: original.disclosure, essence: 'Откройте ссылку https://example.test для проверки' }, 400);
    const [a,b] = await Promise.all([1,2].map(async () => {
      const response = await fetch(api + '/disputes', { method: 'POST', headers: {
        Cookie: 'hwforai_session=' + buyer.token, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ ...initial, disclosureId: original.disclosure, dealId: original.deal }) });
      return { status: response.status, value: await response.json() };
    }));
    assert.deepEqual([a.status,b.status].sort(), [201,409], JSON.stringify([a,b]));
    opened = a.status === 201 ? a.value : b.value;
    assert.equal(opened.status, 'OPENED');
    assert.equal(opened.dealId, original.deal);
    const deadline = await db.query(`
      SELECT extract(isodow FROM notify_by AT TIME ZONE 'Europe/Moscow') AS day,
        (notify_by AT TIME ZONE 'Europe/Moscow')::time=(opened_at AT TIME ZONE 'Europe/Moscow')::time AS same_time
      FROM disputes WHERE id=$1`, [opened.id]);
    assert.ok(Number(deadline.rows[0].day) <= 5);
    assert.equal(new Date(opened.notifyBy).toISOString().slice(11), new Date(opened.openedAt).toISOString().slice(11));
    assert.equal((await db.query("SELECT 1 FROM disclosure_events WHERE disclosure_id=$1 AND type='DISPUTE'", [original.disclosure])).rowCount, 1);
    assert.equal((await db.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='dispute.opened'", [staff.id])).rowCount, 1);
    await call(path(opened.id), { actor: other, status: 404 });
    await call('/admin/disputes', { actor: buyer, status: 403 });
    assert.equal((await call('/disclosures/' + original.disclosure + '/dispute-deals', { actor: buyer })).items[0].id, original.deal);
  });

  await t.test('participant uploads and downloads are scoped, including support during review', async () => {
    await send(path(opened.id) + '/materials', seller, material('Позиция до уведомления'), 409);
    const changed = await send(manage(opened.id) + '/notify', staff);
    assert.equal(changed.status, 'AWAITING_MATERIALS');
    assert.equal((await send(path(opened.id) + '/position', seller, { text: 'Готов передать переписку и счёт.' })).position, 'Готов передать переписку и счёт.');
    await send(path(opened.id) + '/position', buyer, { text: 'Попытка изменить позицию другой стороны.' }, 403);
    await send(path(opened.id) + '/materials', seller, material('Приложена переписка', new Blob(['<html>test</html>'], { type: 'text/html' }), 'evidence.pdf'), 400);
    await send(path(opened.id) + '/materials', seller, material('Приложена переписка',
      new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 1)], { type: 'text/plain' })), 413);
    proof = await send(path(opened.id) + '/materials', seller, material('Переписка: +1 (202) 555-0123 и author@example.test.',
      new Blob(['Согласованное предложение для проверки.'], { type: 'text/plain' })));
    assert.equal(proof.fileName, 'Переписка.txt');
    ownProof = await send(path(opened.id) + '/materials', buyer, material('Своя выписка для проверки экспорта.',
      new Blob(['Личная запись автора.'], { type: 'text/plain' }), 'Выписка.txt'));
    await call(path(opened.id) + '/materials/' + proof.id + '/file', { actor: other, status: 404 });
    const file = await call(path(opened.id) + '/materials/' + proof.id + '/file', { actor: buyer });
    assert.match(file.headers.get('content-disposition'), /^attachment/);
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.match(await file.text(), /Согласованное предложение/);
    assert.equal((await send(manage(opened.id) + '/start-review', staff)).status, 'REVIEW');
    await send(path(opened.id) + '/position', seller, { text: 'Теперь изменить нельзя.' }, 409);
    await send(path(opened.id) + '/materials', seller, material('Новый ответ без вопроса.'), 409);
    const question = await send(path(opened.id) + '/messages', staff, { toUserId: seller.id, body: 'Пожалуйста, поясните дату согласования.' });
    assert.ok(question);
    assert.equal((await call(path(opened.id), { actor: buyer })).messages.length, 0);
    await send(path(opened.id) + '/messages', buyer, { replyTo: question.id, body: 'Ответ на чужой вопрос.' }, 409);
    await send(path(opened.id) + '/messages', seller, { replyTo: question.id, body: 'Дата согласования подтверждена в счёте.' });
    await send(path(opened.id) + '/materials', seller, material('Уточнение к вопросу.', undefined, undefined, question.id));
    const evidence = await call(manage(opened.id) + '/evidence?chatId=' + original.chat, { actor: staff });
    assert.equal(evidence.chatId, original.chat);
    await call(manage(opened.id) + '/evidence?chatId=' + unrelated.chat, { actor: staff, status: 404 });
    assert.equal((await db.query("SELECT 1 FROM moderation_audit WHERE entity='disputes' AND entity_id=$1 AND action='evidence-viewed'", [opened.id])).rowCount, 1);
  });

  await t.test('decision, conflict of interest, audit and reversal keep the last verdict', async () => {
    await db.query("UPDATE users SET link_group='dispute-test-conflict' WHERE id=ANY($1::uuid[])", [[staff.id,seller.id]]);
    await send(manage(opened.id) + '/decide', staff, decision('MISREPRESENTATION', seller.id), 403);
    await db.query('UPDATE users SET link_group=NULL WHERE id=$1', [staff.id]);
    const decided = await send(manage(opened.id) + '/decide', staff, decision('MISREPRESENTATION', seller.id));
    assert.equal(decided.status, 'DECIDED');
    assert.ok(decided.decisions[0].reviewerName);
    const visible = await call(path(opened.id), { actor: buyer });
    assert.equal(visible.decisions[0].reviewerName, null);
    assert.equal(visible.decisions[0].decidedBy, null);
    assert.equal((await db.query('SELECT status FROM listings WHERE id=$1', [original.listing])).rows[0].status, 'FROZEN');
    assert.equal((await db.query('SELECT points FROM user_penalties WHERE dispute_id=$1', [opened.id])).rows[0].points, 10);
    assert.equal(await disputePoints(), 5);
    await assert.rejects(db.query('UPDATE dispute_decisions SET rationale=$2 WHERE dispute_id=$1', [opened.id, decision('NONE').rationale]));
    await send(path(opened.id) + '/withdraw', buyer, {}, 409);
    assert.equal((await send(path(opened.id) + '/review', seller, further)).status, 'REOPENED');
    await send(path(opened.id) + '/review', seller, further, 409);
    await send(path(opened.id) + '/review', buyer, further);
    const extra = await send(path(opened.id) + '/materials', seller, material('Дополнительные документы к пересмотру.'));
    assert.equal(extra.round, 2);
    await send(manage(opened.id) + '/decide', staff, decision('NONE'), 403);
    const reversed = await send(manage(opened.id) + '/decide', admin, decision('NONE'));
    assert.equal(reversed.status, 'DECIDED');
    assert.equal(reversed.reviewUntil, null);
    assert.equal(reversed.decisions.length, 2);
    assert.equal((await db.query('SELECT status FROM listings WHERE id=$1', [original.listing])).rows[0].status, 'ACTIVE');
    assert.equal((await db.query('SELECT 1 FROM user_penalties WHERE dispute_id=$1', [opened.id])).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM moderation_audit WHERE entity='disputes' AND action='penalty-reversed' AND entity_id=$1", [opened.id])).rowCount, 1);
    assert.equal(await disputePoints(), 10);
  });

  const forSeller = await pair();
  await t.test('dispute fee sanction, recall and job deadlines', async () => {
    const dispute = await send('/disputes', buyer, { ...initial, disclosureId: forSeller.disclosure, kind: 'HIDDEN_MARKUP' });
    await db.query(`UPDATE disputes SET notify_by=now()-interval '1 second' WHERE id=$1`, [dispute.id]);
    async function runDeadlines() {
      await db.query("UPDATE ops_job_requests SET requested_at=now()-interval '2 minutes' WHERE job='disputes.deadlines'");
      return send('/admin/jobs/disputes.deadlines/run', admin, {}, 200);
    }
    let job = await runDeadlines();
    assert.equal(job.status, 'DONE', JSON.stringify(job));
    assert.equal((await call(path(dispute.id), { actor: buyer })).status, 'AWAITING_MATERIALS');
    await db.query(`UPDATE disputes SET materials_by=now()+interval '1 minute' WHERE id=$1`, [dispute.id]);
    job = await runDeadlines();
    assert.equal(job.status, 'DONE', JSON.stringify(job));
    assert.equal((await db.query("SELECT 1 FROM notifications WHERE kind='dispute.reminder' AND dedupe_key=$1", ['dispute.reminder:' + dispute.id])).rowCount, 2);
    await db.query(`UPDATE disputes SET materials_by=now()-interval '1 second' WHERE id=$1`, [dispute.id]);
    job = await runDeadlines();
    assert.equal(job.status, 'DONE', JSON.stringify(job));
    assert.equal((await call(path(dispute.id), { actor: buyer })).status, 'REVIEW');
    await send(manage(dispute.id) + '/decide', staff, decision('HIDDEN_MARKUP', seller.id));
    const fee = await db.query("SELECT agent_fee_banned_until>now()+interval '89 days' AS banned FROM users WHERE id=$1", [seller.id]);
    assert.equal(fee.rows[0].banned, true);
    const counter = await send('/disputes', seller, { ...initial, disclosureId: forSeller.disclosure });
    assert.equal((await send(path(counter.id) + '/withdraw', seller)).status, 'CLOSED');
  });

  await t.test('account penalty revokes the session, but the exact one-use appeal is available', async () => {
    const selected = await pair();
    const dispute = await send('/disputes', buyer, { ...initial, disclosureId: selected.disclosure, kind: 'BYPASS' });
    await send(manage(dispute.id) + '/notify', admin);
    await send(manage(dispute.id) + '/start-review', admin);
    await send(manage(dispute.id) + '/decide', staff, decision('BYPASS', seller.id));
    const { rows: [account] } = await db.query('SELECT status,trust_score FROM users WHERE id=$1', [seller.id]);
    assert.deepEqual(account, { status: 'BANNED', trust_score: 0 });
    assert.equal((await db.query('SELECT 1 FROM auth_sessions WHERE user_id=$1', [seller.id])).rowCount, 0);
    const { rows: [email] } = await db.query('SELECT body FROM exchange_email_outbox WHERE dedupe_key=$1 AND recipient=$2',
      ['dispute.decided.blocked:' + dispute.id + ':1', seller.email]);
    const token = /\/a\/([\w-]{43})/.exec(email.body)?.[1];
    assert.ok(token);
    assert.equal((await call('/actions/' + token)).purpose, 'dispute.review');
    const appeal = new FormData();
    appeal.set('text', further.text);
    appeal.set('file', new Blob(['Материал от заблокированной стороны.'], { type: 'text/plain' }), 'Доводы.txt');
    assert.deepEqual(await send('/disputes/review-link/' + token, undefined, appeal), { saved: true });
    assert.equal((await db.query('SELECT round FROM dispute_materials WHERE dispute_id=$1 AND user_id=$2', [dispute.id, seller.id])).rows[0].round, 2);
    await send('/actions/' + token, undefined, further, 409);
    await send(manage(dispute.id) + '/decide', admin, decision('NONE'));
    assert.equal((await db.query('SELECT status FROM users WHERE id=$1', [seller.id])).rows[0].status, 'ACTIVE');
  });

  await t.test('privacy export contains only the requestor’s materials', async () => {
    const requested = await send('/me/data-requests', buyer, { kind: 'EXPORT' });
    await send('/admin/data-requests/' + requested.id + '/export', admin);
    const downloaded = await call('/me/data-requests/' + requested.id + '/export', { actor: buyer });
    const bundle = JSON.parse(gunzipSync(Buffer.from(await downloaded.arrayBuffer())).toString());
    assert.equal(bundle.disputeMaterials.length, 1);
    assert.equal(bundle.disputeMaterials[0].fileName, ownProof.fileName);
    assert.equal(Buffer.from(bundle.disputeMaterials[0].contentBase64, 'base64').toString(), 'Личная запись автора.');
    assert.ok(!JSON.stringify(bundle.disputeMaterials).includes('author@example.test'));
    const response = await db.query('SELECT note FROM dispute_materials WHERE id=$1', [proof.id]);
    assert.match(response.rows[0].note, /author@example.test/);
  });
});
