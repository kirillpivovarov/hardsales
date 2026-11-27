import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { demoRegistrationConsent, solveCaptcha } from './captcha-helper.mjs'

const origin = process.env.HWFORAI_DEAL_PAIRS_TEST_URL?.replace(/\/$/, '')
const database = process.env.HWFORAI_DEAL_PAIRS_DATABASE_URL
const mailpit = process.env.MAILPIT_URL
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
const empty = {}

async function call(actor, path, { method = 'GET', body, status = 200 } = {}) {
  const headers = actor ? { Cookie: actor.cookie } : {}
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(origin + path, {
    method, headers,
    body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
  })
  const result = await response.text()
  assert.equal(response.status, status, method + ' ' + path + ': ' + result)
  return { value: result ? JSON.parse(result) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

const get = async (actor, path, status) => (await call(actor, path, { status })).value
const send = async (actor, path, body = empty, status = 201) => (await call(actor, path, { method: 'POST', body, status })).value
const patch = async (actor, path, body, status = 200) => (await call(actor, path, { method: 'PATCH', body, status })).value
const put = async (actor, path, body, status = 200) => (await call(actor, path, { method: 'PUT', body, status })).value

async function login(login, password = login) {
  const { cookie, value } = await call(null, '/auth/login', { method: 'POST', body: { login, password } })
  assert.ok(cookie)
  return { cookie, user: value.user }
}

async function registrationInput(extra = {}) {
  const username = 'qa-both-' + randomUUID().slice(0, 8)
  const email = username + '@example.test'
  return {
    ...demoRegistrationConsent, role: 'BOTH', username, email, password: 'Deal-Pair-QA-2026!',
    participantType: 'INDIVIDUAL', city: 'Пермь', country: 'RU',
    telegram: username.replaceAll('-', '_'), captchaToken: await solveCaptcha(origin), ...extra,
  }
}

async function registerBoth() {
  const data = await registrationInput()
  const challenge = await send(null, '/auth/register', data)
  for (let attempt = 0; attempt < 20; attempt++) {
    const search = new URLSearchParams({ query: 'to:' + data.email })
    const inbox = await fetch(mailpit + '/api/v1/search?' + search).then(response => response.json())
    if (inbox.messages.length) {
      const detail = await fetch(mailpit + '/api/v1/message/' + inbox.messages[0].ID).then(response => response.json())
      const code = detail.Text.match(/\b\d{6}\b/)?.[0]
      assert.ok(code)
      const { cookie, value } = await call(null, '/auth/verify', { method: 'POST', body: { challengeId: challenge.challengeId, code } })
      assert.ok(cookie)
      return { cookie, user: value.user }
    }
    await delay(150)
  }
  assert.fail('Registration code did not arrive')
}

async function onboarding(actor, expectedGroups) {
  const form = await get(actor, '/onboarding')
  assert.deepEqual(form.groups.map(group => group.key).sort(), expectedGroups)
  const required = form.groups.flatMap(group => group.questions.filter(question => question.required))
  assert.equal(required.length, expectedGroups.length * 3)
  const answers = Object.fromEntries(required.map(question => [question.id, 'Проверяем торговое направление']))
  const { user } = await put(actor, '/onboarding', {
    answers, representationMode: 'DIRECT', rulesVersion: form.rulesVersion, rulesAccepted: true,
  })
  return user
}

function dealFile(id) {
  const form = new FormData()
  form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'deal.pdf')
  form.set('data', JSON.stringify({ kind: 'DEAL_DOC', dealId: id }))
  return form
}

test('repeat deals use one disclosure, with dual-side listing and chat permissions', {
  skip: !origin || !database || !mailpit ? 'Set a disposable demo API, PostgreSQL database and Mailpit' : false,
}, async t => {
  const db = new pg.Pool({ connectionString: database })
  t.after(() => db.end())
  const dbName = (await db.query('SELECT current_database() AS name')).rows[0].name
  assert.match(dbName, /^(maxv_baseline_|hwforai_deal_pairs_)/, 'Only run against a disposable database')
  const seller = await login('test1')
  const regularBuyer = await login('test2')
  let staff = await login('admin')
  if (staff.user.mustChangePassword) {
    const { value, cookie } = await call(staff, '/auth/credentials', { method: 'PATCH', body: {
      currentPassword: 'admin', newPassword: 'Deal-Pair-Admin-2026!',
    } })
    staff = { cookie, user: value.user }
  }
  assert.deepEqual(seller.user.tradeSides, ['SELL'])
  assert.deepEqual(regularBuyer.user.tradeSides, ['BUY'])
  assert.deepEqual(staff.user.tradeSides, [])
  await patch(staff, '/me/trade-sides', {}, 403)
  const { items: [sellerInvite] } = await send(staff, '/admin/invites', { count: 1, presetRole: 'SELLER' })
  const invitationError = await send(null, '/auth/register', await registrationInput({ inviteCode: sellerInvite.code }), 400)
  assert.match(invitationError.message, /Вторую сторону добавьте в профиле/)

  const both = await registerBoth()
  assert.equal(both.user.role, 'SELLER')
  assert.deepEqual(both.user.tradeSides, ['BUY', 'SELL'])
  both.user = await onboarding(both, ['buyer', 'seller'])

  const groups = await get(seller, '/categories')
  const gpu = groups.find(category => category.slug === 'gpu')
  const sellData = { categoryId: gpu.id, modelId: 'h100-sxm', quantity: 3, minLot: 1,
    title: 'Предложение H100 SXM ' + randomUUID().slice(0, 8),
    description: 'Коллективный тест предложений одной пары.', priceMode: 'FIXED', price: 12000, currency: 'USD',
    availability: 'STOCK', originCountry: 'RU', stockCity: 'Москва', shipDays: 2, condition: 'NEW',
    paymentTerms: ['PREPAY_100'], priceInputMode: 'UNIT' }
  const buyData = { categoryId: gpu.id, modelId: 'h100-sxm', quantity: 1, minLot: 1,
    title: 'Заявка H100 SXM ' + randomUUID().slice(0, 8),
    description: 'Коллективный тест заявок одной пары.', priceMode: 'FIXED', price: 16000, currency: 'USD',
    destinationCountry: 'RU', originScope: 'ANY',
    deliveryBy: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), condition: 'NEW', paymentTerms: ['PREPAY_100'],
    priceInputMode: 'UNIT' }

  let offer, bothOffer, bothRequest
  await t.test('one account publishes both kinds and excludes its own cards', async () => {
    await send(regularBuyer, '/listings', { ...sellData, kind: 'SELL' }, 403)
    await send(both, '/listings', sellData, 400)
    await patch(regularBuyer, '/me/trade-sides', { tradeSides: ['BUY', 'BUY'] }, 400)
    const { user } = await patch(regularBuyer, '/me/trade-sides', { tradeSides: ['SELL', 'BUY'] })
    assert.deepEqual(user.tradeSides, ['BUY', 'SELL'])
    assert.equal(user.onboardingState, 'REQUIRED')
    regularBuyer.user = await onboarding(regularBuyer, ['seller'])
    await db.query("UPDATE users SET verification_level=1 WHERE id=ANY($1::uuid[])", [[both.user.id, seller.user.id, regularBuyer.user.id]])
    offer = await send(seller, '/listings', sellData)
    bothOffer = await send(both, '/listings', { ...sellData, kind: 'SELL', title: 'Самостоятельное предложение H100' })
    bothRequest = await send(both, '/listings', { ...buyData, kind: 'BUY' })
    const peerRequest = await send(regularBuyer, '/listings', { ...buyData, kind: 'BUY', title: 'Самостоятельная заявка H100' })
    for (const [side, allowed, own] of [['BUY', peerRequest.id, bothRequest.id], ['SELL', offer.id, bothOffer.id]]) {
      const result = await get(both, '/listings?kind=' + side + '&showAll=true')
      assert.ok(result.items.some(item => item.id === allowed))
      assert.ok(result.items.every(item => item.id !== own && item.kind === side))
    }
    assert.equal((await send(both, '/chats', { listingId: peerRequest.id })).listing.id, peerRequest.id)
    await send(both, '/chats', { listingId: bothRequest.id }, 404)
    await patch(both, '/me/trade-sides', { tradeSides: ['BUY'] }, 409)
    await call(both, '/listings/' + bothOffer.id, { method: 'DELETE', status: 200 })
    const reduced = await patch(both, '/me/trade-sides', { tradeSides: ['BUY'] })
    assert.deepEqual(reduced.user.tradeSides, ['BUY'])
    await send(both, '/listings/' + bothOffer.id + '/restore', {}, 403)
    await patch(both, '/me/trade-sides', { tradeSides: ['BUY', 'SELL'] })
  })

  await t.test('chat, matching and manual repeats share FIRST and protect deal membership', async () => {
    for (const feature of ['feature_disclosure_journal', 'feature_trust_rating', 'feature_matching']) {
      await put(staff, '/admin/settings/' + feature, { value: true })
    }
    await put(staff, '/admin/settings/disclosure_min_level', { value: 0 })
    const unrelated = await send(regularBuyer, '/chats', { listingId: offer.id })
    await send(regularBuyer, '/chats/' + unrelated.id + '/deal', {}, 409)
    const first = await send(both, '/chats', { listingId: offer.id })
    const request = await patch(both, '/chats/' + first.id + '/reveal', { action: 'REQUEST', rulesAccepted: true })
    await patch(seller, '/chats/' + first.id + '/reveal', { action: 'ACCEPT', requestId: request.revealRequestId, rulesAccepted: true })
    const opened = (await get(both, '/deals')).items.find(deal => deal.chatId === first.id)
    assert.equal(opened.origin, 'FIRST_DISCLOSURE')
    assert.equal(opened.sellerId, seller.user.id)
    assert.equal(opened.buyerId, both.user.id)

    const b = await send(seller, '/listings', { ...sellData, title: 'Вторая поставка H100' })
    const second = await send(both, '/chats', { listingId: b.id })
    assert.equal(second.revealState, 'ACCEPTED')
    await send(both, '/chats/' + second.id + '/messages', { body: 'Уточните условия поставки' })
    assert.equal((await get(both, '/chats/' + second.id)).deal.canStart, true)
    await send(seller, '/chats/' + second.id + '/messages', { body: 'Подготовлю предложение' })
    const secondView = await get(both, '/chats/' + second.id)
    const repeat = await get(both, '/deals/' + secondView.deal.id)
    assert.equal(repeat.origin, 'PAIR_CHAT')
    assert.equal(repeat.disclosureId, opened.disclosureId)
    assert.ok(repeat.events.some(event => event.data.dealId === repeat.id && event.data.chatId === second.id))
    await send(regularBuyer, '/deals/' + repeat.id + '/status', { status: 'INVALID' }, 404)

    const c = await send(seller, '/listings', { ...sellData, title: 'Третья поставка H100' })
    const matchRows = await get(both, '/matches?limit=100')
    const match = matchRows.items.find(row => row.counterpart.listing.id === c.id && row.mine.id === bothRequest.id)
    assert.ok(match, 'Regular matching recomputes after listing publication')
    const matched = await send(both, '/matches/' + match.id + '/chat', {}, 200)
    const matchedDeal = await get(both, '/chats/' + matched.chatId).then(chat => get(both, '/deals/' + chat.deal.id))
    assert.equal(matchedDeal.origin, 'PAIR_CHAT')
    assert.equal(matchedDeal.matchId, match.id)
    assert.equal(matchedDeal.buyListingId, bothRequest.id)

    const d = await send(seller, '/listings', { ...sellData, title: 'Сделка вручную H100' })
    const manualChat = await send(both, '/chats', { listingId: d.id })
    const manual = await send(seller, '/chats/' + manualChat.id + '/deal')
    assert.equal(manual.origin, 'MANUAL')
    await send(both, '/chats/' + manualChat.id + '/deal', {}, 409)
    await send(regularBuyer, '/chats/' + manualChat.id + '/deal', {}, 404)
    assert.equal((await get(both, '/deals?pairUserId=' + seller.user.id)).total, 4)
    assert.equal((await get(both, '/deals?pairUserId=' + regularBuyer.user.id)).total, 0)
    assert.equal((await db.query("SELECT count(*)::int AS count FROM disclosures WHERE user_a_id=least($1::uuid,$2::uuid) AND user_b_id=greatest($1::uuid,$2::uuid)", [seller.user.id, both.user.id])).rows[0].count, 1)

    await db.query("UPDATE deals SET created_at=now()-interval '4 days' WHERE id=$1", [repeat.id])
    const run = await send(staff, '/admin/jobs/deals.followups/run', {}, 200)
    assert.equal(run.status, 'DONE')
    const { rows: [followup] } = await db.query(`
      SELECT (followups ? '3') AS after_three,(followups ? '7') AS after_seven,
        (SELECT count(*)::int FROM notifications WHERE kind='deal.followup' AND payload->>'dealId'=$1::text) AS recipient_count
      FROM deals WHERE id=$1::uuid
    `, [repeat.id])
    assert.deepEqual(followup, { after_three: true, after_seven: false, recipient_count: 2 })
    await db.query("UPDATE deals SET created_at=now()-interval '31 days' WHERE id=$1", [manual.id])
    const cleanup = await send(staff, '/admin/jobs/deals.cleanup/run', {}, 200)
    assert.equal(cleanup.status, 'DONE')
    await get(both, '/deals/' + manual.id, 404)
    for (const deal of [opened, repeat]) {
      for (const actor of [both, seller]) await send(actor, '/deals/' + deal.id + '/status', {
        status: 'AGREED', amount: 12000, quantity: 1, currency: 'USD',
      }, 200)
      for (const actor of [both, seller]) await send(actor, '/deals/' + deal.id + '/status', { status: 'EXECUTED' }, 200)
      await send(seller, '/documents', dealFile(deal.id))
      await send(staff, '/admin/deals/' + deal.id + '/verify', { approve: true }, 200)
    }
    assert.equal((await get(both, '/me/trust')).deals, 1)
    const rated = await get(both, '/deals/' + repeat.id)
    assert.ok(rated.ratingNextEligibleAt && new Date(rated.ratingNextEligibleAt) > new Date())
    assert.ok(rated.events.every(event => event.data.dealId === repeat.id))
    assert.ok(rated.events.some(event => event.data.resultingStatus === 'EXECUTED'))
    const { rows: notifications } = await db.query(`
      SELECT n.kind,n.user_id,n.payload->>'dealId' AS deal_id,
        EXISTS(SELECT 1 FROM notification_deliveries delivery WHERE delivery.notification_id=n.id AND delivery.channel='EMAIL') AS email
      FROM notifications n WHERE n.payload->>'dealId'=ANY($1::text[]) AND n.kind IN ('deal.executed_one','deal.executed')
    `, [[opened.id, repeat.id]])
    const repeated = notifications.filter(row => row.deal_id === repeat.id);
    assert.deepEqual(repeated.filter(row => row.kind === 'deal.executed' && row.email).map(row => row.user_id).sort(),
      [both.user.id, seller.user.id].sort())
    assert.deepEqual(repeated.filter(row => row.kind === 'deal.executed_one' && row.email).map(row => row.user_id), [seller.user.id])
    const staffTransport = notifications.filter(row => row.user_id === staff.user.id && row.kind === 'deal.executed')
    assert.equal(staffTransport.find(row => row.deal_id === opened.id).email, true)
    assert.equal(staffTransport.find(row => row.deal_id === repeat.id).email, false)
  })
})
