import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs'

const origin = process.env.HWFORAI_ONBOARDING_BALANCE_TEST_URL?.replace(/\/$/, '')
const smtp = process.env.MAILPIT_URL
const connection = process.env.DATABASE_URL
const prefix = randomBytes(5).toString('hex')

async function request(path, status = 200, { cookie, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const headers = { ...(cookie && { Cookie: cookie }), ...(body && !(body instanceof FormData) && { 'Content-Type': 'application/json' }) }
  const response = await fetch(origin + path, { method, headers, body: body instanceof FormData ? body : JSON.stringify(body) })
  const data = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

const write = async (cookie, path, body, status = 200, method = 'POST') => (await request(path, status, { cookie, body, method })).data
const get = async (cookie, path, status = 200) => (await request(path, status, { cookie })).data

async function emailCode(email) {
  const query = new URLSearchParams({ query: 'to:' + email })
  const outbox = await fetch(`${smtp}/api/v1/search?${query}`).then(response => response.json())
  const message = outbox.messages.find(entry => entry.To.some(recipient => recipient.Address === email))
  assert.ok(message)
  const detail = await fetch(`${smtp}/api/v1/message/${message.ID}`).then(response => response.json())
  const code = detail.Text.match(/\b\d{6}\b/)?.[0]
  assert.ok(code)
  return code
}

function pdf(kind) {
  const form = new FormData()
  form.set('data', JSON.stringify({ kind }))
  form.set('file', new Blob(['%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'], { type: 'application/pdf' }), 'balance-proof.pdf')
  return form
}

test('invite references, premoderation, retained reveal requests, operator draft decisions', {
  skip: !(origin && smtp && connection) && 'Set an isolated demo API, Mailpit and demo database',
}, async t => {
  const database = new pg.Pool({ connectionString: connection })
  t.after(() => database.end())
  const enter = (login, password = login) => request('/auth/login', 200, { body: { login, password } })
  const adminInitial = await enter('admin')
  const { cookie: admin } = await request('/auth/credentials', 200, {
    method: 'PATCH', cookie: adminInitial.cookie, body: { currentPassword: 'admin', newPassword: 'Focused-Balance-Pass-2026!' },
  })
  const { cookie: seller, data: { user: sellerUser } } = await enter('test1')
  const { cookie: buyer, data: { user: buyerUser } } = await enter('test2')
  await database.query("UPDATE listings SET status='ARCHIVED' WHERE owner_id=$1 AND status='ACTIVE'", [sellerUser.id])
  const rawModerator = randomBytes(32).toString('hex')
  const { rows: [{ id: staffId }] } = await database.query(`
    INSERT INTO users(username,email,display_name,password_hash,role,email_verified_at)
    VALUES ($1,$1 || '@example.test','Модератор QA','fixture-no-password','MODERATOR',now()) RETURNING id
  `, ['modbalance' + prefix])
  await database.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [staffId, createHash('sha256').update(rawModerator).digest('hex')])
  const moderator = 'hwforai_session=' + rawModerator
  const set = (key, value) => write(admin, '/admin/settings/' + key, { value }, 200, 'PUT')
  for (const [key, value] of Object.entries({ feature_invites: true, registration_mode: 'INVITE', feature_trust_rating: true,
    feature_disclosure_journal: true, disclosure_min_level: 1, feature_listing_premoderation: true,
    feature_lot_groups: false, disclosure_requires_verified_telegram: false })) await set(key, value)
  const invite = (cookie, data, status = 201) => write(cookie, '/admin/invites', { count: 1, ...data }, status)

  await t.test('staff permissions, one CAPTCHA message, and known-person audit through real email signup', async () => {
    await invite(moderator, { knownPersonally: true, note: 'Совместный проект' }, 403)
    await invite(moderator, { note: 'Приглашение модератора' })
    await invite(admin, { knownPersonally: true }, 400)
    const { items: [personal] } = await invite(admin, { knownPersonally: true, note: 'Ранее покупали у участника' })
    assert.equal(personal.knownPersonally, true)
    const username = 'known' + prefix
    const email = username + '@example.test'
    const form = { ...demoRegistrationConsent, username, email, password: 'Focused-Balance-Password-2026!',
      role: 'BUYER', country: 'RU', city: 'Пермь', participantType: 'INDIVIDUAL', telegram: username, inviteCode: personal.code }
    const { data: missing } = await request('/auth/register', 400, { body: form })
    const messages = [missing.message].flat()
    assert.equal(messages.filter(message => /CAPTCHA/i.test(message)).length, 1)
    const { data: challenge } = await request('/auth/register', 201, { body: { ...form, captchaToken: await solveCaptcha(origin) } })
    const { data: { user }, cookie } = await request('/auth/verify', 200, {
      body: { challengeId: challenge.challengeId, code: await emailCode(email) },
    })
    const state = await get(cookie, '/me/verification')
    assert.equal(state.level, 1)
    assert.equal(state.source, 'OPERATOR_KNOWN')
    const { rows: [audit] } = await database.query(`
      SELECT actor_role,reason FROM moderation_audit WHERE entity_id=$1 AND action='operator-known'
    `, [user.id])
    assert.deepEqual(audit, { actor_role: 'ADMIN', reason: 'Ранее покупали у участника' })
    await write(moderator, '/admin/users/' + user.id + '/verification-revoke', { reason: 'Договор завершён' })
    assert.equal((await get(cookie, '/me/verification')).level, 0)
  })

  const category = (await get(buyer, '/categories')).find(item => item.slug === 'gpu')
  const model = 'h100-sxm'
  const listing = { categoryId: category.id, modelId: model, kind: 'SELL', currency: 'USD', quantity: 2,
    priceMode: 'FIXED', price: 10000, availability: 'STOCK', originCountry: 'RU', stockCity: 'Москва' }
  await write(admin, '/admin/corridors/' + model + '/SELLER_WAREHOUSE', { minUsd: 9500, maxUsd: 10500 }, 200, 'PUT')
  let offer
  await t.test('only price-risk listing pending, staff returns and owner correction publishes', async () => {
    const suspicious = await write(seller, '/listings', { ...listing, price: 15500 }, 201)
    assert.equal(suspicious.status, 'PENDING_REVIEW')
    assert.deepEqual(suspicious.reviewReasons, ['PRICE_OUTSIDE'])
    await get(buyer, '/listings/' + suspicious.id, 404)
    const review = await get(moderator, '/admin/listings?status=PENDING_REVIEW&reviewSignal=PRICE_OUTSIDE')
    assert.ok(review.items.some(item => item.id === suspicious.id))
    await write(seller, '/listings/' + suspicious.id + '/restore', {}, 409)
    await write(moderator, '/admin/listings/' + suspicious.id + '/status', { status: 'ACTIVE', reason: 'Не обходим проверку' }, 409, 'PATCH')
    const returned = await write(moderator, '/admin/listings/' + suspicious.id + '/review',
      { decision: 'RETURN', reason: 'Уточните цену за штуку' }, 201)
    assert.equal(returned.reviewReturnNote, 'Уточните цену за штуку')
    offer = await write(seller, '/listings/' + suspicious.id, { price: listing.price }, 200, 'PATCH')
    assert.equal(offer.status, 'ACTIVE')
    assert.equal(offer.reviewReturnNote, null)
    assert.match(offer.title, /H100/)
    await get(buyer, '/listings/' + offer.id)
    const reviewed = await write(seller, '/listings', { ...listing, price: 16000, quantity: 3 }, 201)
    assert.equal(reviewed.status, 'PENDING_REVIEW')
    const approved = await write(moderator, '/admin/listings/' + reviewed.id + '/review', { decision: 'PUBLISH' }, 201)
    assert.equal(approved.status, 'ACTIVE')
    assert.deepEqual(approved.reviewReasons, [])
    await get(buyer, '/listings/' + approved.id)
  })

  await t.test('draft invisible even by ID, owner actions single-use, and draft rejection leaves evidence', async () => {
    const original = { ...listing, title: 'Поставка для оператора ' + prefix,
      description: 'Предложение создано оператором с дальнейшим подтверждением владельцем.',
      staffSourceNote: 'Подготовлено по разговору с владельцем' }
    const path = '/admin/users/' + sellerUser.id + '/listings'
    await write(buyer, path, original, 403)
    const draft = await write(moderator, path, original, 201)
    assert.equal(draft.status, 'PENDING_OWNER')
    assert.equal(draft.createdByStaff, staffId)
    await get(buyer, '/listings/' + draft.id, 404)
    const links = async id => (await database.query(`
      SELECT payload FROM notifications WHERE kind='listing.owner_confirm' AND payload->>'listingId'=$1
    `, [id])).rows[0].payload
    const getAction = href => '/actions/' + href.split('/').at(-1)
    const pendingLinks = await links(draft.id)
    const first = getAction(pendingLinks.confirmHref)
    const actionable = await get(undefined, first)
    assert.equal(actionable.fields.listingId, draft.id)
    assert.equal(actionable.fields.price, listing.price)
    const published = await write(undefined, first, {})
    assert.equal(published.status, 'ACTIVE')
    await write(undefined, first, {}, 409)
    const preview = await get(buyer, '/listings/' + draft.id)
    assert.equal(preview.createdByStaff, undefined)
    assert.ok((await get(seller, '/listings/' + draft.id)).ownerConfirmedAt)
    const rejection = await write(moderator, path, { ...original, title: 'Отклоняемый черновик ' + prefix }, 201)
    await write(undefined, getAction((await links(rejection.id)).rejectHref), {})
    const { rows: [evidence] } = await database.query(
      "SELECT before_data FROM moderation_audit WHERE entity_id=$1 AND action='owner-rejected'", [rejection.id])
    assert.equal(evidence.before_data.title, rejection.title)
    assert.equal((await database.query('SELECT 1 FROM listings WHERE id=$1', [rejection.id])).rowCount, 0)
    const expiring = await write(moderator, path, { ...original, title: 'Просроченный черновик ' + prefix }, 201)
    const expiredAction = getAction((await links(expiring.id)).confirmHref)
    await database.query("UPDATE listings SET created_at=now()-interval '8 days' WHERE id=$1", [expiring.id])
    await database.query("UPDATE action_tokens SET expires_at=now()-interval '1 day' WHERE subject_id=$1", [expiring.id])
    await get(undefined, expiredAction, 410)
    await write(admin, '/admin/jobs/listings.owner-confirm-expire/run', {})
    assert.equal((await database.query('SELECT 1 FROM listings WHERE id=$1', [expiring.id])).rowCount, 0)
    assert.equal((await database.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='listing.owner_expired'",
      [staffId])).rowCount, 1)
    await get(undefined, expiredAction, 410)
  })

  await t.test('pending reveal retained; two approved documents unlock the request', async () => {
    await database.query("UPDATE users SET verification_level=1,verification_source='OPERATOR_KNOWN' WHERE id=$1", [sellerUser.id])
    const chat = await write(buyer, '/chats', { listingId: offer.id }, 201)
    const path = '/chats/' + chat.id + '/reveal'
    const denied = await write(buyer, path, { action: 'REQUEST', rulesAccepted: true }, 403, 'PATCH')
    assert.equal(denied.code, 'VERIFICATION_REQUIRED_SELF')
    assert.equal(denied.requiredDocuments.length, 2)
    const pending = await write(seller, path, { action: 'REQUEST', rulesAccepted: true }, 200, 'PATCH')
    assert.equal(pending.revealState, 'REQUESTED')
    const initial = await get(buyer, '/me/verification')
    assert.deepEqual(initial.requirements.map(({ status }) => status), ['MISSING','MISSING'])
    const confirm = { action: 'ACCEPT', requestId: pending.revealRequestId, rulesAccepted: true }
    await write(buyer, path, confirm, 403, 'PATCH')
    await write(moderator, '/admin/users/' + buyerUser.id + '/verify', { level: 1 }, 400)
    for (const { kind } of initial.requirements) {
      const uploaded = await write(buyer, '/documents', pdf(kind), 201)
      await write(moderator, '/admin/documents/' + uploaded.id + '/approve', {})
    }
    await write(moderator, '/admin/users/' + buyerUser.id + '/verify', { level: 1 })
    assert.equal((await get(buyer, '/me/verification')).source, 'DOCUMENTS')
    const { rowCount } = await database.query(
      "SELECT 1 FROM notifications WHERE user_id=$1 AND kind='verification.partner_ready'", [sellerUser.id])
    assert.equal(rowCount, 1)
    const accepted = await write(buyer, path, confirm, 200, 'PATCH')
    assert.equal(accepted.revealState, 'ACCEPTED')
    assert.ok(accepted.telegram.partner)
  })
})
