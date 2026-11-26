import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DatabaseService } = require('../dist/database/database.service.js');
const { ModelsService } = require('../dist/models/models.service.js');
const { CatalogSyncService } = require('../dist/models/catalog-sync.service.js');
const { PlatformSettings } = require('../dist/exchange/platform-settings.js');
const { ExchangeNotifications } = require('../dist/exchange/notifications.js');
const { parsePciIds, eligiblePciName, serverSignals, sourceUrl, calendarWeek, readCatalogBody, MAX_CATALOG_BYTES } = require('../dist/models/catalog-sources.js');

const localDatabase = process.env.HWFORAI_MODELS_TEST_DATABASE_URL;
const apiOrigin = process.env.HWFORAI_MODELS_TEST_URL?.replace(/\/$/, '');
const actorId = '00000000-0000-4000-8150-000000000001';
const memberId = '00000000-0000-4000-8150-000000000002';
const sessionHash = 'a'.repeat(64);
const actor = { id: actorId, role: 'ADMIN', username: 'models-admin', sessionHash };
const member = { id: memberId, role: 'BUYER', username: 'models-buyer' };

function pciFixture(total = 1200) {
  const rows = Array.from({ length: total }, (_, index) => `\t${index.toString(16).padStart(4, '0')}  Device ${index}`);
  return `10de  NVIDIA Corporation\n${rows.join('\n')}\n\t2335  GH100 [H200 SXM 141GB]\n\t2b00  GB110 [B300]\n\t2c00  XX100 [H300 SXM 200GB]\n\t2d00  GB203 [GeForce RTX 5090 Laptop GPU]\n\t\t2f00  Subdevice [B300]\nC 00  Unclassified device\n\t2f01  [B300]`;
}

function clock(day) {
  return { now: new Date(`${day}T04:00:00Z`), timezone: 'UTC', day, hour: 4 };
}

test('bounded source validation and parser preserve desktop/server products', async () => {
  assert.equal(sourceUrl('PCI_IDS', 'https://pci-ids.ucw.cz/v2.2/pci.ids'), 'https://pci-ids.ucw.cz/v2.2/pci.ids');
  for (const url of ['http://pci-ids.ucw.cz/', 'https://pci-ids.ucw.cz@example.com/', 'https://pci-ids.ucw.cz:444/',
    'https://en.wikipedia.org/', 'https://127.0.0.1/', 'https://pci-ids.ucw.cz/#credentials']) {
    assert.throws(() => sourceUrl('PCI_IDS', url), { status: 400 });
  }
  const parsed = parsePciIds(pciFixture(), ['10de']);
  assert.equal(parsed.size, 1204);
  assert.equal(parsed.has('10de:2f00'), false);
  assert.equal(eligiblePciName(parsed.get('10de:2d00').names[0]), false);
  assert.deepEqual(serverSignals('NVIDIA_PAGES', '<script>HGX H800</script> NVIDIA <b>HGX B400 NVL16</b>'), ['HGX B400 NVL16']);
  assert.equal(calendarWeek('2027-01-01'), '2026-W53');
  await assert.rejects(readCatalogBody(new Response(new Uint8Array(MAX_CATALOG_BYTES + 1))), /5 МиБ/);
});

test('model aliases, private proposals and moderated PCI import', { skip: !localDatabase }, async () => {
  process.env.DATABASE_URL = localDatabase;
  const db = new DatabaseService();
  const notifications = new ExchangeNotifications(db, {}, {});
  const models = new ModelsService(db, notifications);
  const noticesOf = userId => notifications.list(userId, {}).then(result => result.items);
  const registered = new Map();
  const sync = new CatalogSyncService(db, { register: job => registered.set(job.name, job) }, new PlatformSettings(db), models);
  const originalFetch = globalThis.fetch;
  sync.onModuleInit();
  try {
    await db.migrate();
    const seed = await db.query(`SELECT count(*)::int AS count FROM hardware_models WHERE status = 'ACTIVE'`);
    assert.equal(seed.rows[0].count, 35);
    await db.query(`INSERT INTO users (id, username, display_name, email, password_hash, role, email_verified_at)
      VALUES ($1, 'models-admin', 'Admin Models', 'models-admin@example.test', 'disposable-fixture', 'ADMIN', now())`, [actorId]);
    await db.query(`INSERT INTO users (id,username,display_name,email,password_hash,role,participant_type,city,country,telegram,email_verified_at)
      VALUES ($1,'models-buyer','Buyer Models','models-buyer@example.test','disposable-fixture','BUYER','INDIVIDUAL','Москва','RU','models_buyer',now())`, [memberId]);
    await db.query(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now() + interval '1 hour')`, [actorId, sessionHash]);

    assert.equal((await models.suggest({ q: 'Н200 SXM' })).items[0].id, 'h200-sxm');
    assert.equal((await models.suggest({ q: 'H 200 NVL' })).items[0].id, 'h200-nvl');
    const serverMatches = await models.browse(member, { category: 'servers', q: 'Н-200' });
    const serverIds = serverMatches.families.flatMap(group => group.models.map(model => model.id));
    assert.ok(['hgx-h200-8', 'hgx-h200-4', 'dgx-h200'].every(id => serverIds.includes(id)), serverIds);
    assert.ok((await models.analogs(member, 'hgx-h200-8')).group.some(model => model.id === 'dgx-h200'));
    const { model: proposed } = await models.proposal(member, { name: 'HGX QA NVL16', category: 'servers' });
    assert.equal(proposed.status, 'PENDING');
    assert.ok((await models.browse(member, { category: 'servers' })).families.flatMap(group => group.models).some(model => model.id === proposed.id));
    assert.ok(!(await models.browse(actor, { category: 'servers' })).families.flatMap(group => group.models).some(model => model.id === proposed.id));
    assert.ok((await noticesOf(actorId)).some(notice => notice.kind === 'model.proposed' && notice.payload.modelId === proposed.id));
    await models.approve(actor, proposed.id, {});
    assert.ok((await noticesOf(memberId)).some(notice => notice.kind === 'model.approved' && notice.payload.modelId === proposed.id));

    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, ...options });
      if (url.includes('pci-ids.ucw.cz')) return new Response(null, { status: 503 });
      if (url.includes('raw.githubusercontent.com')) return new Response(pciFixture(), { headers: { ETag: '"file-a"' } });
      if (url.includes('nvidia.com')) return new Response('NVIDIA <b>HGX B400 NVL16</b>');
      return new Response(JSON.stringify({ parse: { wikitext: { '*': 'NVIDIA DGX B400' } } }));
    };
    const run = (name, day) => db.transaction(client => registered.get(name).run(client, clock(day)));
    await run('catalog.pci', '2026-11-25');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.redirect === 'error'));
    const { rows: [lastSeen] } = await db.query(`SELECT pci_last_seen_at FROM hardware_models WHERE id='h200-sxm'`);
    assert.ok(lastSeen.pci_last_seen_at);
    const queue = (await sync.items({})).items;
    assert.ok(queue.some(item => item.externalId === '10de:2b00' && item.kind === 'LINK_PCI' && item.modelId === 'b300-sxm'));
    const item = queue.find(item => item.externalId === '10de:2c00');
    assert.equal(item.kind, 'NEW_MODEL');
    assert.equal(item.modelId, 'pci-10de-2c00');
    assert.ok(!queue.some(row => ['10de:2335', '10de:2d00', '10de:2f00'].includes(row.externalId)));
    assert.ok(!(await models.browse(member, {})).families.flatMap(group => group.models).some(model => model.id === item.modelId));
    await sync.decide(actor, item.id, { decision: 'MERGE', intoModelId: 'b300-sxm' });
    assert.ok((await models.readAdmin(db, 'b300-sxm')).pciIds.includes('10de:2c00'));
    assert.equal((await models.readAdmin(db, item.modelId)).status, 'DISABLED');
    const { rows: [event] } = await db.query(`SELECT actor_user_id FROM moderation_audit WHERE entity='catalog_sync' AND action='merge'`);
    assert.equal(event.actor_user_id, actorId);
    await run('catalog.pci', '2026-11-25');
    assert.equal(requests.length, 2);
    globalThis.fetch = async (url, options) => {
      requests.push({ url, ...options });
      if (url.includes('pci-ids.ucw.cz')) return new Response(null, { status: 503 });
      assert.equal(options.headers['If-None-Match'], '"file-a"');
      return new Response(null, { status: 304 });
    };
    await run('catalog.pci', '2026-11-26');
    assert.equal((await sync.sources()).find(source => source.code === 'PCI_IDS').lastStatus, 'NOT_MODIFIED');
    globalThis.fetch = async () => new Response(pciFixture(50));
    await run('catalog.pci', '2026-11-27');
    assert.equal((await sync.sources()).find(source => source.code === 'PCI_IDS').lastStatus, 'REJECTED');
    globalThis.fetch = async url => url.includes('nvidia.com') ? new Response('NVIDIA <b>HGX B400 NVL16</b>')
      : new Response(JSON.stringify({ parse: { wikitext: { '*': 'NVIDIA DGX B400' } } }));
    await run('catalog.servers', '2026-11-30');
    assert.ok((await sync.items({ kind: 'SIGNAL' })).items.some(row => row.rawName === 'HGX B400 NVL16'));
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM hardware_models WHERE category_slug='servers' AND status='PENDING'`)).rows[0].count, 0);
    const failures = [];
    globalThis.fetch = async url => { failures.push(url); return new Response(null, { status: 503 }); };
    for (let repeat = 0; repeat < 5; repeat += 1) await run('catalog.pci', '2026-12-01');
    assert.equal(failures.length, 8, 'Both addresses must stop at four checks per day');
    await run('catalog.pci', '2026-12-02');
    await run('catalog.pci', '2026-12-03');
    assert.ok((await noticesOf(actorId)).some(notice => notice.kind === 'catalog_sync.unavailable'));
    const beforeDemo = process.env.DEMO_MODE;
    const beforeOptIn = process.env.CATALOG_SYNC_IN_DEMO;
    try {
      process.env.DEMO_MODE = 'true';
      delete process.env.CATALOG_SYNC_IN_DEMO;
      assert.equal(await registered.get('catalog.pci').enabled(), false);
    } finally {
      if (beforeDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = beforeDemo;
      if (beforeOptIn === undefined) delete process.env.CATALOG_SYNC_IN_DEMO;
      else process.env.CATALOG_SYNC_IN_DEMO = beforeOptIn;
    }

  } finally {
    globalThis.fetch = originalFetch;
    await db.onApplicationShutdown();
  }
});

test('member proposal and staff approval deliver notifications through HTTP', { skip: !apiOrigin }, async () => {
  async function call(path, { cookie, method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(apiOrigin + path, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return { cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }

  async function demoLogin(login) {
    const session = await call('/auth/login', { method: 'POST', body: { login, password: login } });
    assert.ok(session.cookie);
    return session;
  }

  const seller = await demoLogin('test1');
  const buyer = await demoLogin('test2');
  let admin = await demoLogin('admin');
  if (admin.body.user.mustChangePassword) {
    admin = await call('/auth/credentials', { cookie: admin.cookie, method: 'PATCH',
      body: { currentPassword: 'admin', newPassword: `Models-fixture-${randomUUID()}` } });
  }
  const draft = { name: `HGX QA ${randomUUID().slice(0, 8)} SXM`, category: 'servers' };
  const { body: { model } } = await call('/models/proposals', { cookie: seller.cookie, method: 'POST', body: draft, status: 201 });
  assert.equal(model.status, 'PENDING');
  const notifications = async session => (await call('/notifications', { cookie: session.cookie })).body.items;
  const buyerModels = async () => (await call('/models?category=servers', { cookie: buyer.cookie })).body.families.flatMap(group => group.models);
  assert.ok(!(await buyerModels()).some(item => item.id === model.id));
  assert.ok((await notifications(admin)).some(item => item.kind === 'model.proposed' && item.payload.modelId === model.id));
  assert.ok(!(await notifications(buyer)).some(item => item.payload.modelId === model.id));
  await call(`/admin/models/${model.id}/approve`, { cookie: seller.cookie, method: 'POST', body: {}, status: 403 });
  await call(`/admin/models/${model.id}/approve`, { cookie: admin.cookie, method: 'POST', body: {}, status: 201 });
  assert.ok((await buyerModels()).some(item => item.id === model.id));
  assert.ok((await notifications(seller)).some(item => item.kind === 'model.approved' && item.payload.modelId === model.id));
});
