import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';

const migrationDatabase = process.env.HWFORAI_PRICE_TEST_DATABASE_URL;
const runtimeDatabase = process.env.HWFORAI_PRICE_HTTP_DATABASE_URL;
const origin = process.env.HWFORAI_PRICE_TEST_URL?.replace(/\/+$/, '');
const api = origin?.endsWith('/api/v1') ? origin : origin && origin + '/api/v1';
const demoOffer = '00000000-0000-4000-8110-000000000001';
const demoOwner = '00000000-0000-4000-8000-000000000001';

test('unit-price migration preserves seeded and legacy listing records and meaningful history', {
  skip: !migrationDatabase && 'Provide a clean HWFORAI_PRICE_TEST_DATABASE_URL',
}, async () => {
  const client = new pg.Client({ connectionString: migrationDatabase });
  await client.connect();
  try {
    assert.equal((await client.query("SELECT to_regclass('public.listings') AS table")).rows[0].table, null);
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
    await client.query('BEGIN');
    for (const file of files.filter(name => name < '026')) {
      await client.query(await readFile(new URL(file, directory), 'utf8'));
    }
    const owner = randomUUID();
    const legacy = randomUUID();
    const minor = randomUUID();
    const single = randomUUID();
    await client.query(`INSERT INTO users (id,username,display_name,email,password_hash,role,participant_type,city,country,telegram,email_verified_at)
      VALUES ($1,'price-fixture','Участник','price-fixture@example.test','fixture','SELLER','INDIVIDUAL','Москва','RU','price_fixture',now()),
        ($2,'seed-pricing','Продавец','seed-pricing@example.test','fixture','SELLER','INDIVIDUAL','Москва','RU','seed_pricing',now())`, [owner, demoOwner]);
    const listing = (id, ownerId, title, quantity, price, currency = 'RUB') => client.query(`
      INSERT INTO listings(id,owner_id,category_id,kind,title,description,quantity,condition,price_mode,price,currency,
        availability,origin_scope,origin_country,stock_city,vat,counterparty)
      SELECT $1,$2,id,'SELL',$3,'Оборудование в хорошем состоянии. Проверка цены.', $4,'NEW','FIXED',$5,$6,
        'STOCK','COUNTRY','RU','Москва','NA','ANY'
      FROM categories WHERE slug='gpu'`, [id, ownerId, title, quantity, price, currency]);
    await listing(legacy, owner, 'Ускоритель NVIDIA L40S', 8, 16_000_000);
    await client.query('UPDATE listings SET price=$2 WHERE id=$1', [legacy, 15_120_000]);
    await listing(demoOffer, demoOwner, 'Демонстрационный H100', 8, 1_890_000);
    await listing(minor, owner, 'Тест усреднения копейки', 8, 0.01);
    await listing(single, owner, 'Ускоритель ровно один', 1, 700, 'KZT');
    const oldHistory = (await client.query(`SELECT id,changed_at,source,quantity FROM listing_price_history
      WHERE listing_id=$1 ORDER BY id`, [legacy])).rows;
    const oldSnapshot = (await client.query(`SELECT disclosure_listing_snapshot(l) AS snapshot FROM listings l WHERE id=$1`, [legacy])).rows[0].snapshot;
    assert.equal(oldSnapshot.price, 15_120_000);
    assert.equal(oldSnapshot.priceBasis, undefined);
    await client.query('COMMIT');
    await client.query('BEGIN');
    for (const file of files.filter(name => name >= '026' && name < '029')) {
      await client.query(await readFile(new URL(file, directory), 'utf8'));
    }
    await client.query('COMMIT');

    const rows = (await client.query(`SELECT id,price::float8,price_usd::float8,search_words FROM listings`)).rows;
    const row = id => rows.find(row => row.id === id);
    assert.equal(row(legacy).price, 1_890_000);
    assert.equal(row(legacy).price_usd, 19_845);
    assert.ok(row(legacy).search_words.includes('l40c'));
    assert.equal(row(demoOffer).price, 1_890_000);
    assert.equal(row(minor).price, 0.01);
    assert.equal(row(single).price, 700);
    assert.equal(row(single).price_usd, null);
    const nextHistory = (await client.query(`SELECT id,changed_at,source,quantity,price::float8 FROM listing_price_history
      WHERE listing_id=$1 ORDER BY id`, [legacy])).rows;
    assert.deepEqual(nextHistory.map(({ price, ...row }) => row), oldHistory);
    assert.deepEqual(nextHistory.map(row => row.price), [2_000_000, 1_890_000]);
    const demoHistory = (await client.query(`SELECT price::float8 FROM listing_price_history WHERE listing_id=$1`, [demoOffer])).rows;
    assert.deepEqual(demoHistory.map(row => row.price), [1_890_000]);
    const notices = (await client.query(`SELECT user_id,actions FROM notifications WHERE kind='listing.price_unit'`)).rows;
    assert.deepEqual(notices, [{ user_id: owner, actions: [{ label: 'Мои объявления', href: '/my-listings' }] }]);
    const newSnapshot = (await client.query(`SELECT disclosure_listing_snapshot(l) AS snapshot FROM listings l WHERE id=$1`, [legacy])).rows[0].snapshot;
    assert.deepEqual([newSnapshot.priceBasis, newSnapshot.price, newSnapshot.totalPrice], ['UNIT', 1_890_000, 15_120_000]);
    await client.query('UPDATE listings SET currency=$2 WHERE id=$1', [single, 'USD']);
    assert.equal((await client.query('SELECT price_usd::float8 FROM listings WHERE id=$1', [single])).rows[0].price_usd, 700);
  } finally {
    await client.end();
  }
});

test('catalogue, mandatory models, USD conversion and FX update use unit prices', {
  skip: !api && 'Provide a disposable demo at HWFORAI_PRICE_TEST_URL',
}, async () => {
  async function call(path, { method = 'GET', cookie, data, status = 200 } = {}) {
    const response = await fetch(api + path, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(data !== undefined && { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
    return { body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const seller = (await call('/auth/login', { method: 'POST', data: { login: 'test1', password: 'test1' } })).cookie;
  const buyer = (await call('/auth/login', { method: 'POST', data: { login: 'test2', password: 'test2' } })).cookie;
  let admin = await call('/auth/login', { method: 'POST', data: { login: 'admin', password: 'admin' } });
  if (admin.body.user.mustChangePassword) {
    admin = await call('/auth/credentials', { method: 'PATCH', cookie: admin.cookie,
      data: { currentPassword: 'admin', newPassword: `Prices-fixture-${randomUUID()}` } });
  }
  const categories = (await call('/categories')).body;
  const gpu = categories.find(category => category.slug === 'gpu');
  const cpu = categories.find(category => category.slug === 'cpu');
  assert.equal(gpu.requiresModel, true);
  assert.equal(cpu.requiresModel, false);
  const tag = 'priceqa' + randomUUID().slice(0, 8).replaceAll('-', '');
  const base = {
    title: 'Проверка цен ' + tag, description: 'Проверяем сортировку цены за одну единицу.',
    condition: 'NEW', quantity: 8, availability: 'STOCK', stockCity: 'Москва', originCountry: 'RU',
    priceMode: 'FIXED', price: 1_890_000, currency: 'RUB', categoryId: cpu.id,
  };
  const offer = (data = {}, status = 201) => call('/listings', { method: 'POST', cookie: seller, data: { ...base, ...data }, status }).then(record => record.body);
  assert.deepEqual((({ code, field }) => [code, field])(await offer({ categoryId: gpu.id }, 400)), ['MODEL_REQUIRED', 'modelId']);
  assert.equal((await offer({ price: 1e15 }, 400)).message, 'Цена за шт.: не больше 999 999 999,99');
  const rub = await offer();
  assert.deepEqual([rub.price, rub.totalPrice, rub.priceUsd, rub.totalPriceUsd], [1_890_000, 15_120_000, 19_845, 158_760]);
  assert.equal((await call('/listings/' + rub.id, { cookie: buyer })).body.totalPrice, rub.totalPrice);
  const usd = await offer({ currency: 'USD', price: 25_000 });
  const cny = await offer({ currency: 'CNY', price: 12_000 });
  const unknown = await offer({ currency: 'KZT', price: 50_000 });
  const negotiable = await offer({ priceMode: 'NEGOTIABLE' });
  const find = query => call('/listings?' + new URLSearchParams({ q: tag, showAll: 'true', ...query }), { cookie: buyer }).then(record => record.body.items);
  assert.deepEqual((await find({ sort: 'price-asc' })).slice(0, 3).map(item => item.id), [cny.id, rub.id, usd.id]);
  assert.deepEqual(new Set((await find({ sort: 'price-desc' })).slice(3).map(item => item.id)), new Set([unknown.id, negotiable.id]));
  assert.deepEqual((await find({ priceMin: 1000, priceMax: 1700 })).map(item => item.id), [cny.id]);
  assert.deepEqual((await find({ priceMax: 2_000_000, currency: 'RUB' })).map(item => item.id), [rub.id]);
  const updateRate = () => call('/admin/fx-rates/RUB', { method: 'PUT', cookie: admin.cookie, data: { usdPerUnit: 0.02 } });
  if (runtimeDatabase) {
    const client = new pg.Client({ connectionString: runtimeDatabase });
    await client.connect();
    let updating;
    try {
      const parallelId = randomUUID();
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO listings (id,owner_id,category_id,kind,title,description,quantity,condition,price_mode,price,currency,
          availability,origin_scope,origin_country,stock_city,vat,counterparty)
        SELECT $1,owner_id,category_id,kind,'Параллельная публикация',description,quantity,condition,price_mode,price,currency,
          availability,origin_scope,origin_country,stock_city,vat,counterparty
        FROM listings WHERE id=$2
      `, [parallelId, rub.id]);
      updating = updateRate();
      void updating.catch(() => undefined);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const { rows: [lock] } = await client.query(`
          SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=18403 AND objid=32
            AND mode='ExclusiveLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting
        `);
        waiting = lock.waiting;
        if (!waiting) await wait(50);
      }
      assert.equal(waiting, true, 'The rate change waits for an in-flight listing price write');
      assert.equal((await call('/listings/' + rub.id, { cookie: buyer })).body.priceUsd, 19_845);
      await client.query('COMMIT');
      await updating;
      assert.equal((await call('/listings/' + parallelId, { cookie: buyer })).body.priceUsd, 37_800);
    } finally {
      await client.query('ROLLBACK');
      await updating?.catch(() => undefined);
      await client.end();
    }
  } else await updateRate();
  assert.equal((await call('/listings/' + rub.id, { cookie: buyer })).body.priceUsd, 37_800);
  assert.deepEqual((await find({ sort: 'price-asc' })).slice(0, 3).map(item => item.id), [cny.id, usd.id, rub.id]);
  const required = await call('/listings/' + rub.id, { method: 'PATCH', cookie: seller, data: { categoryId: gpu.id }, status: 400 });
  assert.equal(required.body.field, 'modelId');
  const { model } = (await call('/models/proposals', {
    method: 'POST', cookie: seller, data: { name: 'Тестовый GPU ' + tag, category: 'gpu' }, status: 201,
  })).body;
  const pending = await offer({ categoryId: gpu.id, modelId: model.id, price: 2000, currency: 'USD' });
  assert.equal(pending.model.status, 'PENDING');
  assert.equal(pending.priceUsd, 2000);
  assert.equal((await call('/models/h100-sxm/price-check?price=5000&quantity=8&currency=USD', { cookie: seller })).body.looksLikeTotal, false);
  await call('/admin/corridors/h100-pcie/SELLER_WAREHOUSE', { method: 'PUT', cookie: admin.cookie,
    data: { minUsd: 22000, maxUsd: 27000 } });
  for (const [price, quantity, currency, looksLikeTotal] of [
    [500000, 51, 'USD', true], [500000, 50, 'USD', false], [450000, 51, 'USD', false], [500000, 51, 'KZT', false],
  ]) {
    const parameters = new URLSearchParams({ price, quantity, currency });
    assert.deepEqual((await call('/models/h100-pcie/price-check?' + parameters, { cookie: seller })).body, { looksLikeTotal });
  }
  for (const q of ['H100', 'h100', 'Н100', 'h-100']) {
    const { body: { items } } = await call('/models/suggest?' + new URLSearchParams({ q }), { cookie: seller });
    assert.deepEqual(new Set(items.map(item => item.id)), new Set(['h100-sxm', 'h100-pcie', 'hgx-h100-8', 'dgx-h100']));
  }
  for (const q of ['dell r760', 'Л40С']) {
    assert.ok((await call('/listings?' + new URLSearchParams({ q, showAll: 'true' }), { cookie: buyer })).body.items.length, q);
  }
  const withoutModel = (await call('/admin/listings?withoutModel=true&limit=100', { cookie: admin.cookie })).body.items;
  assert.ok(withoutModel.length && withoutModel.every(item => item.requiresModel && item.modelId === null));
  const { body: subcategory } = await call('/admin/categories', { method: 'POST', cookie: admin.cookie, status: 201,
    data: { slug: 'gpu-' + tag, name: 'Ускорители для проверки', parentId: gpu.id } });
  assert.equal((await offer({ categoryId: subcategory.id }, 400)).field, 'modelId');
});
