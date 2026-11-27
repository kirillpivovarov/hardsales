import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const origin = process.env.HWFORAI_TRUST_TEST_URL?.replace(/\/$/, '')
const workingPassword = 'Verified-Trust-Owner-2026!'
const codeNote = 'Ручная проверка документа в тестовом контуре.'
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2LIAAAAASUVORK5CYII=', 'base64')

async function call(path, { cookie, method = 'GET', body, status = 200 } = {}) {
  const headers = cookie ? { Cookie: cookie } : {}
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(origin + path, {
    method, headers, body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
  })
  assert.equal(response.status, status, method + ' ' + path + ': ' + await response.clone().text())
  return response
}

async function login(login, password = login) {
  const response = await call('/auth/login', { method: 'POST', body: { login, password } })
  return { cookie: response.headers.get('set-cookie')?.split(';')[0], user: (await response.json()).user }
}

function forms(fields, data = pdf, mime = 'application/pdf', filename = 'test.pdf') {
  const body = new FormData()
  body.set('file', new Blob([data], { type: mime }), filename)
  body.set('data', JSON.stringify(fields))
  return body
}
const mutate = (actor, path, body, status = 200, method = 'POST') => call(path, { cookie: actor.cookie, method, body, status })
const get = (actor, path, status = 200) => call(path, { cookie: actor.cookie, status })

test('trust verification, private files and post-disclosure deals', { skip: !origin && 'Set a disposable demo URL under /api/v1' }, async t => {
  let admin = await login(process.env.HWFORAI_TRUST_ADMIN ?? 'admin', process.env.HWFORAI_TRUST_PASSWORD ?? 'admin')
  const seller = await login('test1')
  const buyer = await login('test2')
  if (admin.user.mustChangePassword) {
    const response = await mutate(admin, '/auth/credentials', { currentPassword: 'admin', newPassword: workingPassword }, 200, 'PATCH')
    admin = { cookie: response.headers.get('set-cookie')?.split(';')[0], user: (await response.json()).user }
  }
  await get(seller, '/me/trust', 404)
  for (const feature of ['feature_disclosure_journal', 'feature_actuality', 'feature_trust_rating']) {
    await mutate(admin, '/admin/settings/' + feature, { value: true }, 200, 'PUT')
  }

  await t.test('verify accounts, deny forged signatures and make files owner/staff only', async () => {
    const own = await get(seller, '/me/trust').then(response => response.json())
    assert.equal(own.level, 0)
    assert.equal(own.factors.length, 8)
    assert.equal(own.listingLimit, 3)
    const category = (await get(seller, '/categories').then(response => response.json())).find(item => item.slug === 'gpu')
    const limitOffer = {
      categoryId: category.id, modelId: 'h100-sxm', title: 'Проверяем лимит предложения ' + randomUUID().slice(0, 8),
      description: 'Независимая фикстура для лимита активных объявлений.',
      stockCity: 'Пермь', availability: 'STOCK', originCountry: 'RU',
    }
    for (let count = own.listingsUsed; count < 3; count++) await mutate(seller, '/listings', limitOffer, 201)
    await mutate(seller, '/listings', limitOffer, 409)
    const fake = forms({ kind: 'COMPANY_CARD' }, Buffer.from('504b030400', 'hex'))
    await mutate(seller, '/documents', fake, 400)
    for (const actor of [seller, buyer]) {
      const upload = await mutate(actor, '/documents', forms({ kind: 'COMPANY_CARD' }), 201).then(response => response.json())
      assert.equal(upload.status, 'PENDING')
      assert.ok(!('content' in upload))
      if (actor === seller) {
        await get(buyer, '/documents/' + upload.id + '/file', 404)
        const staffDownload = await get(admin, '/documents/' + upload.id + '/file')
        assert.match(staffDownload.headers.get('content-disposition'), /^attachment/)
        assert.equal(staffDownload.headers.get('x-content-type-options'), 'nosniff')
        assert.equal(staffDownload.headers.get('cache-control'), 'no-store')
        assert.deepEqual(Buffer.from(await staffDownload.arrayBuffer()), pdf)
        const history = await get(admin, '/admin/audit?q=' + upload.id).then(response => response.json())
        assert.ok(history.items.some(item => item.action === 'file-downloaded' && item.actorUserId === admin.user.id))
      }
      const approved = await mutate(admin, '/admin/users/' + actor.user.id + '/verify', { level: 1 }).then(response => response.json())
      assert.equal(approved.level, 1)
    }
  })

  let offer
  await t.test('day proof case folding, listing privacy and manual publication suspension', async () => {
    const category = (await get(seller, '/categories').then(response => response.json())).find(item => item.slug === 'gpu')
    const source = {
      categoryId: category.id, modelId: 'h200-sxm', title: 'NVIDIA H200 для проверки ' + randomUUID().slice(0, 8),
      description: 'Тестовое предложение по проверяемому оборудованию.',
      stockCity: 'Москва', availability: 'STOCK', originCountry: 'RU', paymentTerms: ['PREPAY_100'],
    }
    offer = await mutate(seller, '/listings', source, 201).then(response => response.json())
    const code = await mutate(admin, '/admin/users/' + seller.user.id + '/day-codes', { listingId: offer.id, spotCheck: true }, 201).then(response => response.json())
    assert.match(code.code, /^[ABCDEFGHJKMNPRSTUVWXYZ][1-9]-[0-9]{4}$/)
    const upload = await mutate(seller, '/documents', forms({
      kind: 'SERIAL_PHOTO', listingId: offer.id, dayCode: code.code.toLowerCase(),
    }, png, 'image/png', 'serial.png'), 201).then(response => response.json())
    assert.equal(upload.dayCodeOk, true)
    await mutate(admin, '/admin/documents/' + upload.id + '/approve', {})
    const publicView = await get(buyer, '/listings/' + offer.id).then(response => response.json())
    assert.equal(publicView.trust.proof, 'STOCK')
    assert.equal(publicView.trust.ownerLevel, 1)
    assert.ok(!publicView.trustFactors)
    assert.ok(!('minUsd' in publicView.trust))

    await mutate(admin, '/admin/users/' + seller.user.id + '/restrict', { note: codeNote })
    await mutate(seller, '/listings', source, 403)
    assert.equal((await get(admin, '/admin/listings/' + offer.id).then(response => response.json())).status, 'FROZEN')
    await mutate(admin, '/admin/users/' + seller.user.id + '/verify', { level: 1 })
    await mutate(admin, '/admin/listings/' + offer.id + '/status', { status: 'ACTIVE', reason: codeNote }, 200, 'PATCH')
  })

  await t.test('create first disclosure deal, serialize both acknowledgements and audit verification', async () => {
    const chat = await mutate(buyer, '/chats', { listingId: offer.id }, 201).then(response => response.json())
    const request = await mutate(buyer, '/chats/' + chat.id + '/reveal', { action: 'REQUEST', rulesAccepted: true }, 200, 'PATCH').then(response => response.json())
    await mutate(seller, '/chats/' + chat.id + '/reveal', { action: 'ACCEPT', requestId: request.revealRequestId, rulesAccepted: true }, 200, 'PATCH')
    const { items: [deal] } = await get(seller, '/deals').then(response => response.json())
    assert.equal(deal.status, 'NEGOTIATING')
    assert.equal(deal.sellerId, seller.user.id)
    assert.equal(deal.buyerId, buyer.user.id)
    const action = (actor, body, status = 200) => mutate(actor, '/deals/' + deal.id + '/status', body, status)
    await action(seller, { status: 'EXECUTED' }, 409)
    await action(seller, { status: 'AGREED', amount: 20000, quantity: 1, currency: 'USD' })
    const other = await action(buyer, { status: 'AGREED', amount: 19999, quantity: 1, currency: 'USD' }).then(response => response.json())
    assert.equal(other.status, 'AGREED')
    assert.equal(other.amountMismatch, true)
    await action(buyer, { status: 'AGREED', amount: 20000, quantity: 1, currency: 'USD' })
    const execution = await Promise.all([action(seller, { status: 'EXECUTED' }), action(buyer, { status: 'EXECUTED' })])
    assert.deepEqual((await Promise.all(execution.map(response => response.json()))).map(item => item.status).sort(), ['AGREED', 'EXECUTED'])
    await action(seller, { status: 'FAILED', reason: 'Сроки' }, 409)
    await mutate(admin, '/admin/deals/' + deal.id + '/verify', { approve: true }, 409)
    await mutate(seller, '/documents', forms({ kind: 'DEAL_DOC', dealId: deal.id }), 201)
    const verified = await mutate(admin, '/admin/deals/' + deal.id + '/verify', { approve: true }).then(response => response.json())
    assert.ok(verified.adminVerifiedAt)
    assert.ok(verified.events.some(event => event.type === 'DEAL_VERIFIED'))
    for (const actor of [seller, buyer]) {
      const trust = await get(actor, '/me/trust').then(response => response.json())
      assert.equal(trust.level, 2)
      assert.equal(trust.deals, 1)
      assert.equal(trust.listingLimit, null)
    }
    const report = await mutate(buyer, '/chats/' + chat.id + '/reports', {
      reason: 'FRAUD', scope: 'ON_PLATFORM', details: 'Проверяем пересчёт рейтинга после решения по спору.',
    }, 201).then(response => response.json())
    const score = async () => (await get(buyer, '/listings/' + offer.id).then(response => response.json())).trust.ownerScore
    const before = await score()
    await mutate(admin, '/admin/reports/' + report.id + '/status', { status: 'RESOLVED', reason: codeNote }, 200, 'PATCH')
    assert.equal(await score(), before - 5)
    await mutate(admin, '/admin/reports/' + report.id + '/status', { status: 'OPEN', reason: codeNote }, 200, 'PATCH')
    assert.equal(await score(), before)
  })

  await t.test('price corridor excludes the offer itself and low-rating filters preserve owner access', async () => {
    const category = (await get(seller, '/categories').then(response => response.json())).find(item => item.slug === 'servers')
    const source = {
      categoryId: category.id, modelId: 'hgx-h200-8', availability: 'STOCK', originCountry: 'RU', stockCity: 'Москва',
      priceMode: 'FIXED', currency: 'USD', deliveryIncluded: false, quantity: 10,
      description: 'Сервер для независимой проверки границ ценового коридора.',
    }
    for (const price of [290000, 300000, 310000, 320000, 330000]) {
      const listed = await mutate(seller, '/listings', { ...source, price, title: `HGX H200 согласованное предложение ${price}` }, 201)
        .then(response => response.json())
      assert.equal(listed.totalPrice, price * 10)
    }
    const title = 'Сервер для проверки пограничной цены ' + randomUUID().slice(0, 8)
    const item = await mutate(seller, '/listings', { ...source, price: 450000, title }, 201).then(response => response.json())
    assert.equal(item.trust.corridor, true)
    assert.equal(item.trustFactors.price, 0)
    const path = '/listings?q=' + encodeURIComponent(title)
    await mutate(admin, '/admin/settings/low_rating_threshold', { value: 99 }, 200, 'PUT')
    try {
      const hidden = await get(buyer, path).then(response => response.json())
      assert.equal(hidden.items.some(row => row.id === item.id), false)
      assert.ok(hidden.hiddenLowRating >= 1)
      const all = await get(buyer, `${path}&showAll=true`).then(response => response.json())
      const publicItem = all.items.find(row => row.id === item.id)
      assert.equal(publicItem.trust.corridor, true)
      assert.ok(!('hiddenByRatingBelow' in publicItem) && !('trustFactors' in publicItem) && !('minUsd' in publicItem.trust))
      const own = await get(seller, `/listings/mine?q=${encodeURIComponent(title)}`).then(response => response.json())
      assert.equal(own.items.find(row => row.id === item.id).hiddenByRatingBelow, 99)
    } finally {
      await mutate(admin, '/admin/settings/low_rating_threshold', { value: 30 }, 200, 'PUT')
    }
  })
})
