import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { DatabaseService } = require('../dist/database/database.service.js')
const { CatalogService } = require('../dist/market/catalog.service.js')
const { ExchangeJobs } = require('../dist/exchange/jobs.js')
const { ActualityService } = require('../dist/exchange/actuality.service.js')
const { ExchangeNotifications } = require('../dist/exchange/notifications.js')
const { PlatformSettings } = require('../dist/exchange/platform-settings.js')
const { VerificationService } = require('../dist/exchange/verification.service.js')
const { MatchingService } = require('../dist/matching/matching.service.js')
const { LotDetection } = require('../dist/lots/lot-detection.js')
const { LotGroupsService } = require('../dist/lots/lot-groups.service.js')
const { lotComponents, recommendLotPrimary } = require('../dist/lots/lot-rules.js')
const integrationDatabase = process.env.HWFORAI_LOTS_TEST_DATABASE_URL

test('lot graph uses exact five-percent boundary, distinct sellers and durable exclusions', () => {
  const make = (id, usdPerUnit, ownerId = id) => ({ id, ownerId, usdPerUnit, modelId: 'h200' })
  const a = make('a', '100000.0000000000')
  const equal = make('b', '105000.0000000000')
  const high = make('c', '105000.0000000100')
  const far = make('d', '110000.0000000000')
  assert.equal(lotComponents([a, equal], [], 0.05).length, 1)
  assert.equal(lotComponents([a, high], [], 0.05).length, 0)
  assert.equal(lotComponents([a, make('same', '100002.00', 'a')], [], 0.05).length, 0)
  assert.deepEqual(lotComponents([a, equal, far], [], 0.05).map(group => group.map(offer => offer.id)), [['a', 'b', 'd']])
  assert.ok(lotComponents([a, equal, far], [{ listingA: 'a', listingB: 'd' }], 0.05).every(group => group.length < 3))
})

test('exclusive approved mandate precedes earliest confirmation and the direct owner', () => {
  const sharedCompany = 'Склад  Олёкма'
  const direct = { listingId: 'owner-listing', ownerId: 'owner', representation: 'DIRECT', ownerCompany: sharedCompany,
    confirmedAt: null, listingStatus: 'ACTIVE', membershipRole: 'MEMBER' }
  const earlier = { listingId: 'earlier', ownerId: 'agent-1', representation: 'AGENT', principalUserId: 'owner',
    principalLegalName: 'склад олекма', confirmedAt: new Date('2026-09-01'), listingStatus: 'ACTIVE', membershipRole: 'MEMBER' }
  const later = { ...earlier, listingId: 'later', ownerId: 'agent-2', confirmedAt: new Date('2026-10-01'),
    exclusiveMandate: true, mandateStatus: 'APPROVED' }
  assert.equal(recommendLotPrimary([direct, earlier, later], null, null).resolution, 'EXCLUSIVE_MANDATE')
  assert.equal(recommendLotPrimary([direct, earlier, { ...later, mandateStatus: 'PENDING' }], true, null).listingId, 'earlier')
  assert.equal(recommendLotPrimary([direct, { ...earlier, confirmedAt: null }], true, null).resolution, 'PRINCIPAL_OWN')
  assert.equal(recommendLotPrimary([direct, { ...earlier, exclusiveMandate: true, mandateStatus: 'APPROVED' }, later], true, null), null)
  assert.equal(recommendLotPrimary([direct, earlier, later], false, null), null)
})

test('moderated lot lifecycle, private agency documents and catalogue aggregation on PostgreSQL', {
  skip: !integrationDatabase && 'Use a fresh disposable PostgreSQL database',
}, async t => {
  process.env.DATABASE_URL = integrationDatabase
  const db = new DatabaseService()
  t.after(() => db.onApplicationShutdown())
  await db.migrate()
  const settings = new PlatformSettings(db)
  const jobs = new ExchangeJobs(db, settings)
  const notifications = new ExchangeNotifications(db, jobs, {})
  const detector = new LotDetection(jobs, settings, notifications)
  const matching = new MatchingService(db, settings, jobs, notifications, {})
  const lots = new LotGroupsService(db, settings, notifications, detector, matching)
  const catalog = new CatalogService(db, {}, {}, {}, {}, settings, matching)
  detector.onModuleInit()
  let serial = 0
  const addUser = async (name, role) => {
    const participant = role === 'BUYER' || role === 'SELLER'
    const { rows: [row] } = await db.query(`
      INSERT INTO users(username,display_name,email,password_hash,role,participant_type,city,country,telegram,email_verified_at)
      VALUES ($1,$1,$1 || '@example.test','disposable', $2,$3,$4,$5,$6,now()) RETURNING id
    `, [name, role, participant ? 'INDIVIDUAL' : null, participant ? 'Москва' : null, participant ? 'RU' : null, participant ? name : null])
    if (!participant) await db.query(`
      INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')
    `, [row.id, String(++serial).repeat(64)])
    return { id: row.id, username: name, role, emailVerified: true, status: 'ACTIVE', mustChangePassword: false,
      sessionHash: participant ? undefined : String(serial).repeat(64) }
  }
  const actor = await addUser('lotsmoderator', 'MODERATOR')
  const buyer = await addUser('lotsbuyer', 'BUYER')
  const a = await addUser('lotsagenta', 'SELLER')
  const b = await addUser('lotsagentb', 'SELLER')
  const c = await addUser('lotsdirectc', 'SELLER')
  const d = await addUser('lotsdirectd', 'SELLER')
  const principal = async (agent, company, confirmed) => {
    const { rows: [row] } = await db.query(`
      INSERT INTO user_principals(user_id,number,name,company,platform_user_id,confirmed_at,confirmed_via)
      VALUES ($1,1,'Контакт агента',$2,$3,$4,CASE WHEN $4::timestamptz IS NOT NULL THEN 'ADMIN' END) RETURNING id
    `, [agent.id, company, c.id, confirmed])
    return row.id
  }
  const principalA = await principal(a, 'ООО Общий склад', '2026-01-01')
  const principalB = await principal(b, 'ООО Общий склад', '2026-01-02')
  const offer = async (actor, title, price, city, settings = {}) => {
    const { rows: [row] } = await db.query(`
      INSERT INTO listings(owner_id,category_id,kind,title,description,quantity,condition,price_mode,price,currency,
        availability,origin_scope,origin_country,stock_city,vat,counterparty,model_id,representation,principal_id,trust_score,agent_fee_disclosed)
      SELECT $1,id,'SELL',$2,'Выделенный тестовый лот.',6,'NEW','FIXED',$3,$4,$5,$6,$7,$8,'NA','ANY',
        'hgx-h200-8',$9,$10,$11,CASE WHEN $10::uuid IS NOT NULL THEN false END FROM categories WHERE slug='servers' RETURNING id
    `, [actor.id, title, price, settings.currency ?? 'USD', city === null ? 'TRANSIT' : 'STOCK',
      settings.scope ?? 'COUNTRY', settings.scope === 'ANY' ? null : 'HK', city,
      settings.principal ? 'AGENT' : 'DIRECT', settings.principal ?? null, settings.score ?? 70])
    return row.id
  }
  const first = await offer(a, 'Сервер первый', 600000, 'Гонконг  Юг ', { principal: principalA, score: 65 })
  const second = await offer(b, 'Сервер второй', 629000, 'гонконг юг', { principal: principalB, score: 90 })
  const third = await offer(c, 'Сервер третий', 650000, '  ГОНКОНГ ЮГ', { score: 75 })
  const high = await offer(d, 'Сервер дороже', 750000, 'гонконг юг')
  const noRate = await offer(d, 'Сервер без курса', 620000, 'гонконг юг', { currency: 'KZT' })
  const anyPlace = await offer(d, 'Сервер без склада', 620000, null, { scope: 'ANY' })
  const noCity = await offer(d, 'Сервер в пути', 620000, null)
  await db.query("UPDATE platform_settings SET value='true' WHERE key='feature_lot_groups'")
  await jobs.runNow('lots.detect', 'lots-fixture:1')
  const { items: detected } = await lots.list({})
  assert.equal(detected.length, 1)
  const group = detected[0]
  assert.deepEqual(new Set(group.members.map(member => member.listingId)), new Set([first, second, third]))
  assert.ok([high, noRate, anyPlace, noCity].every(id => !group.members.some(member => member.listingId === id)))
  assert.equal(group.recommendation.resolution, 'FIRST_CONFIRMED')

  const browse = await catalog.browse({ q: 'Сервер', limit: 1, showAll: true, sort: 'trust' }, buyer)
  assert.equal(browse.total, 5, 'group replaces three rows before count and pagination')
  const cards = await catalog.browse({ q: 'Сервер', limit: 20, showAll: true }, buyer)
  const card = cards.items.find(item => item.lotGroup)
  assert.equal(card.id, second)
  assert.deepEqual(card.lotGroup, { id: group.id, participants: 3, primary: true, collapsedCount: 2 })
  const alternative = await lots.publicMembers(buyer, second)
  assert.deepEqual(new Set(alternative.items.map(item => item.id)), new Set([first, third]))
  assert.doesNotMatch(JSON.stringify(alternative), /ООО Общий склад|principalLegalName|mandateDocumentId|lotsagenta@example\.test/)
  const privateRows = await catalog.mine(a, {})
  assert.equal(privateRows.items[0].similarLot, true)
  assert.doesNotMatch(JSON.stringify(privateRows), /lotsagentb|lotGroup/)
  await assert.rejects(lots.publicMembers(a, second), { status: 404 })
  assert.equal((await catalog.browse({ q: 'Сервер третий' }, buyer)).items[0].id, third)
  await db.query("UPDATE platform_settings SET value='true' WHERE key='feature_trust_rating'")
  await db.query('UPDATE listings SET trust_score=10 WHERE id=$1', [high])
  const rated = await catalog.browse({ q: 'Сервер' }, buyer)
  assert.equal(rated.total, 4)
  assert.equal(rated.hiddenLowRating, 1)
  await db.query("UPDATE platform_settings SET value='false' WHERE key='feature_trust_rating'")

  assert.equal((await lots.requestPrincipals(actor, group.id)).created, 2)
  assert.equal((await lots.requestPrincipals(actor, group.id)).created, 0)
  const requestA = (await lots.myRequests(a)).items[0]
  const requestB = (await lots.myRequests(b)).items[0]
  assert.equal(requestA.listingId, first)
  assert.equal(requestB.listingId, second)
  assert.deepEqual(await lots.myRequests(c), { items: [] })
  await assert.rejects(lots.answer(b, requestA.id, { principalLegalName: 'ООО Общий склад', exclusiveMandate: false }), { status: 404 })
  const verification = new VerificationService(db, settings, notifications, jobs,
    { requireEnabled: async () => {}, refresh: async () => {} })
  const mandate = await verification.upload(b.id, {
    originalname: 'mandate.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture'),
  }, { kind: 'MANDATE', listingId: second, principalId: principalB })
  assert.equal(mandate.status, 'PENDING')
  await assert.rejects(lots.answer(a, requestA.id, { principalLegalName: 'ООО Общий склад',
    exclusiveMandate: true, mandateDocumentId: mandate.id }), { status: 400 })
  await lots.answer(b, requestB.id, { principalLegalName: 'ООО Общий склад', exclusiveMandate: true, mandateDocumentId: mandate.id })
  await assert.rejects(lots.answer(b, requestB.id, { principalLegalName: 'ООО Общий склад', exclusiveMandate: true }), { status: 409 })
  assert.equal((await lots.detail(group.id)).recommendation.resolution, 'FIRST_CONFIRMED')
  await verification.review(actor, mandate.id, true, {})
  assert.equal((await db.query('SELECT proof_status FROM listings WHERE id=$1', [second])).rows[0].proof_status, 'NONE')
  assert.deepEqual((await lots.detail(group.id)).recommendation, { listingId: second, resolution: 'EXCLUSIVE_MANDATE' })
  await assert.rejects(lots.resolve(actor, group.id, { primaryListingId: first, resolution: 'OPERATOR' }), { status: 400 })
  await assert.rejects(lots.resolve(actor, group.id, { primaryListingId: first, resolution: 'EXCLUSIVE_MANDATE' }), { status: 400 })
  await db.query('UPDATE listings SET price=900000 WHERE id=$1', [third])
  await assert.rejects(lots.resolve(actor, group.id, { primaryListingId: second, resolution: 'EXCLUSIVE_MANDATE' }), { status: 409 })
  await db.query('UPDATE listings SET price=650000 WHERE id=$1', [third])

  const { rows: [demand] } = await db.query(`
    INSERT INTO listings(owner_id,category_id,kind,title,description,quantity,condition,price_mode,price,currency,
      origin_scope, destination_country,delivery_by,vat,counterparty,model_id)
    SELECT $1,id,'BUY','Заявка на лот','Тестовая закупка оборудования.',6,'NEW','FIXED',700000,'USD',
      'ANY','RU',current_date+14,'NA','ANY','hgx-h200-8' FROM categories WHERE slug='servers' RETURNING id
  `, [buyer.id])
  await db.query("UPDATE platform_settings SET value='true' WHERE key='feature_matching'")
  await db.query(`
    INSERT INTO listing_matches(sell_listing_id,buy_listing_id,seller_id,buyer_id,type)
    VALUES($1,$2,$3,$4,'FULL')
  `, [first, demand.id, a.id, buyer.id])
  const resolved = await lots.resolve(actor, group.id, { primaryListingId: second, resolution: 'EXCLUSIVE_MANDATE' })
  assert.equal(resolved.status, 'RESOLVED')
  const { rows: [hidden] } = await db.query('SELECT status,hidden_reason,duplicate_of FROM listings WHERE id=$1', [first])
  assert.deepEqual(hidden, { status: 'HIDDEN', hidden_reason: 'DUPLICATE', duplicate_of: second })
  assert.equal((await db.query('SELECT status FROM listing_matches WHERE sell_listing_id=$1 AND buy_listing_id=$2',
    [first, demand.id])).rows[0].status, 'VOID')
  assert.ok((await catalog.mine(a, {})).items[0].isDuplicate)
  const actuality = new ActualityService(db, settings, {}, matching, {}, notifications)
  await assert.rejects(db.transaction(client => actuality.ownerArchive(client, a.id, first, true)), { status: 409 })
  await db.transaction(client => actuality.ownerArchive(client, a.id, first, false))
  await assert.rejects(db.transaction(client => actuality.ownerArchive(client, a.id, first, true)), { status: 409 })
  await assert.rejects(lots.publicMembers(buyer, second), { status: 404 })
  await lots.appeal(a, first, { reason: 'Отдельная поставка на другом складе.' })
  assert.ok((await lots.detail(group.id)).members.find(member => member.listingId === first).appealReason)
  assert.equal((await lots.restore(actor, group.id, first, { note: 'Другая поставка подтверждена.' })).status, 'ACTIVE')
  assert.equal((await db.query('SELECT duplicate_of FROM listings WHERE id=$1', [first])).rows[0].duplicate_of, null)
  assert.equal((await db.query("SELECT count(*)::int AS count FROM moderation_audit WHERE entity='lot_groups' AND entity_id=$1", [group.id])).rows[0].count, 4)

  const x = await offer(a, 'Лот в другом районе первый', 600000, 'Гонконг Север')
  const y = await offer(b, 'Лот в другом районе второй', 610000, 'Гонконг Север')
  await jobs.runNow('lots.detect', 'lots-fixture:2')
  const otherGroup = (await lots.list({ status: 'OPEN' })).items.find(item => item.members.some(member => member.listingId === x))
  assert.ok(otherGroup.members.some(member => member.listingId === y))
  await lots.dissolve(actor, otherGroup.id, { note: 'Два разных склада.' })
  await jobs.runNow('lots.detect', 'lots-fixture:3')
  assert.ok(!(await lots.list({ status: 'OPEN' })).items.some(item => item.members.some(member => [x, y].includes(member.listingId))))

  const low = await offer(a, 'Граница первая', 600000, 'Новый район')
  const middle = await offer(c, 'Граница вторая', 620000, 'Новый район')
  const upper = await offer(b, 'Граница третья', 655000, 'Новый район', { principal: principalB })
  const top = await offer(d, 'Граница четвёртая', 675000, 'Новый район')
  await jobs.runNow('lots.detect', 'lots-fixture:4')
  const beforeMerge = (await lots.list({ status: 'OPEN' })).items
  const earlierGroup = beforeMerge.find(item => item.members.some(member => member.listingId === low))
  const laterGroup = beforeMerge.find(item => item.members.some(member => member.listingId === upper))
  assert.notEqual(earlierGroup.id, laterGroup.id)
  await lots.requestPrincipals(actor, laterGroup.id)
  const movedRequest = (await lots.myRequests(b)).items.find(item => item.listingId === upper)
  const bridge = await offer(a, 'Связующее объявление', 638000, 'Новый район')
  await jobs.runNow('lots.detect', 'lots-fixture:5')
  assert.equal((await lots.detail(laterGroup.id)).status, 'DISSOLVED')
  const joined = await lots.detail(earlierGroup.id)
  assert.deepEqual(new Set(joined.members.filter(member => member.membershipRole === 'MEMBER').map(member => member.listingId)),
    new Set([low, middle, upper, top, bridge]))
  assert.equal((await lots.myRequests(b)).items.find(item => item.listingId === upper).id, movedRequest.id)
  const grouped = await catalog.browse({ city: 'Новый район' }, buyer)
  assert.equal(grouped.items[0].lotGroup.collapsedCount, 3)
  assert.equal((await lots.publicMembers(buyer, grouped.items[0].id)).items.length, 3)
})
