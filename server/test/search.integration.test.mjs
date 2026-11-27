import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const configuredOrigin = process.env.HWFORAI_SEARCH_TEST_URL?.replace(/\/+$/, '');
const api = configuredOrigin?.endsWith('/api/v1') ? configuredOrigin : configuredOrigin && configuredOrigin + '/api/v1';
const suffix = randomUUID().replaceAll('-', '').slice(0, 8);

async function call(path, { method = 'GET', cookie, body, status = 200 } = {}) {
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? undefined : await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
  return { payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login(username) {
  const { cookie } = await call('/auth/login', { method: 'POST', body: { login: username, password: username } });
  assert.ok(cookie);
  return cookie;
}

test('catalogue search recognizes equipment variants and retains exact constraints', {
  skip: !api && 'Set HWFORAI_SEARCH_TEST_URL to a disposable demo',
}, async t => {
  const seller = await login('test1');
  const buyer = await login('test2');
  const { payload: categories } = await call('/categories');
  const { id: gpu } = categories.find(category => category.slug === 'gpu');
  const { id: servers } = categories.find(category => category.slug === 'servers');

  async function offer(title, specs, { categoryId = gpu, price = 100, description = 'Проверка нормализации и ранжирования оборудования.' } = {}) {
    const { payload } = await call('/listings', {
      method: 'POST', cookie: seller, status: 201,
      body: {
        categoryId, modelId: categoryId === servers ? 'hgx-h100-8' : 'h100-sxm', title: `${title} ${suffix}`, description,
        quantity: 1, condition: 'NEW', availability: 'STOCK', originCountry: 'RU',
        stockCity: 'Новосибирск', priceMode: 'FIXED', price, currency: 'RUB', specs,
      },
    });
    return payload;
  }

  async function search(q, options = {}, cookie = buyer, route = '/listings') {
    const { payload } = await call(route + '?' + new URLSearchParams({ q, limit: 100, ...options }), { cookie });
    return payload.items.map(item => item.id);
  }

  function includes(items, ...listings) {
    for (const item of listings) assert.ok(items.includes(item.id), `Missing ${item.title}`);
  }

  function excludes(items, ...listings) {
    for (const item of listings) assert.ok(!items.includes(item.id), `Should exclude ${item.title}`);
  }

  const exact = await offer('NVIDIA H100 SXM 80 GB', {}, { price: 100 });
  const variant = await offer('Ускоритель Нвидиа Н-100', { Формат: 'SXM 5', Видеопамять: '80 Гбайт' }, { price: 50 });
  const differentModel = await offer('NVIDIA H200 SXM 80 GB', {});
  const differentInterface = await offer('NVIDIA H100 PCI-E 80 Gb', {});
  const differentMemory = await offer('NVIDIA H100 SXM 180 ГБ', {});

  await t.test('combines editable fields, brands, alphabets, units, spacings and typos', async () => {
    for (const query of ['NVIDIA H100 SXM 80GB', 'нвидиа н‑100 SXM 80 ГБ', 'Nivdia H 100 80 ГБ SXM', 'Nvida H100 SXM 80ГБ']) {
      const results = await search(query);
      includes(results, exact, variant);
      excludes(results, differentModel, differentInterface, differentMemory);
    }
    includes(await search('Nivdia'), variant);
    includes(await search('H100 PCI Express'), differentInterface);
    excludes(await search('H100 PCI Express'), exact, variant);
    includes(await search('H100 SXM-5'), variant);
    excludes(await search('H100 SXM4'), variant);
    assert.deepEqual(await search('! - —'), []);
  });

  await t.test('keeps relevance, explicit sorts, facets, pagination and role visibility', async () => {
    const q = 'NVIDIA H100 SXM 80 GB';
    const relevant = await search(q);
    const cheap = await search(q, { sort: 'price-asc' });
    const recent = await search(q, { sort: 'newest' });
    assert.ok(relevant.indexOf(exact.id) < relevant.indexOf(variant.id));
    assert.ok(cheap.indexOf(variant.id) < cheap.indexOf(exact.id));
    assert.ok(recent.indexOf(variant.id) < recent.indexOf(exact.id));
    const priced = await search(q, { priceMax: 75, currency: 'RUB', category: 'gpu' });
    includes(priced, variant);
    excludes(priced, exact);
    const first = await search(q, { limit: 1 });
    const second = await search(q, { limit: 1, page: 2 });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0], second[0]);
    assert.deepEqual(await search(q, { kind: 'SELL' }, seller), []);
    const { payload: guest } = await call('/listings?' + new URLSearchParams({ q }));
    assert.equal(guest.locked, true);
    assert.deepEqual(guest.items, []);
    includes(await search(q, {}, seller, '/listings/mine'), exact, variant);
  });

  await t.test('matches numeric SKU families, unit decimals and technical variants exactly', async () => {
    const rtx = await offer('Nvidia RTX-4090', {});
    const older = await offer('Nvidia RTX 3090', {});
    const dell = await offer('Делл Power Edge R-750 2 U', { Накопитель: 'NV-Me 1,92 ТБ' }, { categoryId: servers });
    const wrongDell = await offer('Dell PowerEdge R760 2U', { Накопитель: 'NVMe 192TB' }, { categoryId: servers });
    const epyc = await offer('АМД ЭПИК 9654', { Сокет: 'SP-5' }, { categoryId: servers });
    const perByte = await offer('Пропускная способность', { Скорость: '100 GB/s' });
    const perBit = await offer('Пропускная способность', { Скорость: '100 Гбит/с' });
    const article = await offer('华为 Ascénd', { Артикул: 'SAS-292846' });
    for (const q of ['4090', 'rtx4090', 'Ге Форс 4090']) {
      const results = await search(q);
      includes(results, rtx);
      excludes(results, older);
    }
    const racks = await search('Dell PowerEdge R750 2U NVMe 1.920tb');
    includes(racks, dell);
    excludes(racks, wrongDell);
    includes(await search('AMD EPYC 9654 SP5'), epyc);
    includes(await search('100 GB/s'), perByte);
    excludes(await search('100 GB/s'), perBit);
    includes(await search('100 Gbps'), perBit);
    excludes(await search('100 Gbps'), perByte);
    includes(await search('华为 ascénd SAS292846'), article);

    await call('/listings/' + dell.id, {
      method: 'PATCH', cookie: seller, body: { title: `Dell PowerEdge R752 2U ${suffix}` },
    });
    excludes(await search('Dell R750 2U 1.92TB'), dell);
    includes(await search('Dell R752 2U 1.92TB'), dell);
  });
});
