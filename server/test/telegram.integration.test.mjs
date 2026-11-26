import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { parseActualityChange, noticeContent } = require('../dist/telegram/telegram-buttons.js');
const { ExchangeNotifications } = require('../dist/exchange/notifications.js');
const databaseUrl = process.env.HWFORAI_TELEGRAM_TEST_DATABASE_URL;
const token = '456780012:local_test_bot_token_00000';
const secret = 'local_test_webhook_secret_0000000000';
const sellerId = '00000000-0000-4000-8000-000000000001';
const sellerChat = 87210001234;
const buyerChat = 87210001235;

async function eventually(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(75);
  }
  assert.fail(typeof description === 'function' ? description() : description);
}

async function localListen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function localPort() {
  const server = createServer();
  const port = await localListen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function nextEvent() {
  let id = 100;
  return (chat, text, options = {}) => ({ update_id: ++id,
    message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat, username: 'fixture_tg' }, text, ...options },
  });
}

test('Telegram content bounds and Russian amount entry', () => {
  assert.deepEqual(parseActualityChange('цена 1 750 000; количество 6'), { answer: 'CHANGED', price: 1750000, quantity: 6 });
  assert.deepEqual(parseActualityChange('цена 1.750.000,25, количество 2'), { answer: 'CHANGED', price: 1750000.25, quantity: 2 });
  assert.deepEqual(parseActualityChange('количество 1 000\nцена 80,5'), { answer: 'CHANGED', price: 80.5, quantity: 1000 });
  for (const invalid of ['', 'только текст', 'цена -1', 'количество 1,5', 'цена 10; цена 20']) assert.equal(parseActualityChange(invalid), null);
  const secretAction = 'T'.repeat(43);
  const text = noticeContent({ id: '9223372036854775807', kind: 'match.new', title: 'Тест', body: 'я'.repeat(5500), payload: {},
    actions: Array.from({ length: 10 }, () => ({ label: 'Написать', token: secretAction, action: 'match.chat' })),
  });
  assert.ok(text.text.length <= 4096);
  assert.ok(text.reply_markup.inline_keyboard.length <= 8);
  assert.ok(!JSON.stringify(text).includes(secretAction));
  for (const row of text.reply_markup.inline_keyboard) for (const button of row) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('Telegram webhook, private binds, actualities, split delivery and polling use the local Bot API', {
  skip: !databaseUrl && 'Set an empty disposable HWFORAI_TELEGRAM_TEST_DATABASE_URL', timeout: 260000,
}, async t => {
  const db = new Pool({ connectionString: databaseUrl });
  let mock;
  let app;
  t.after(async () => {
    await stopApp();
    if (mock?.listening) await new Promise(resolve => {
      mock.close(resolve);
      mock.closeAllConnections();
    });
    await db.end();
  });
  assert.equal((await db.query("SELECT to_regclass('public.users') AS existing")).rows[0].existing, null,
    'Telegram integration requires an empty disposable database');
  const calls = [];
  const pendingUpdates = [];
  let messageNo = 750;
  let failNext;
  mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const method = url.pathname.split('/').pop();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const log = { method, body, at: Date.now() };
    calls.push(log);
    let result = true;
    let failure;
    if (!url.pathname.startsWith('/bot' + token + '/')) failure = { error_code: 401, description: 'Unexpected test credential' };
    else if (method === 'getMe') result = { id: 101, username: 'hwforai_fixture_bot', is_bot: true };
    else if (method === 'getWebhookInfo') result = { url: calls.findLast(item => item.method === 'setWebhook')?.body.url, pending_update_count: 0 };
    else if (method === 'getUpdates') {
      result = pendingUpdates.filter(update => update.update_id >= body.offset);
      if (!result.length) await delay(150);
    } else if (method === 'sendMessage') {
      if (failNext && body.text.startsWith(failNext.title)) {
        failure = failNext.failure;
        failNext = undefined;
      }
      result = { message_id: ++messageNo, chat: { id: Number(body.chat_id), type: 'private' } };
      log.messageId = result.message_id;
    }
    response.writeHead(failure?.error_code ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failure ? { ok: false, ...failure } : { ok: true, result }));
  });
  const fakeOrigin = `http://127.0.0.1:${await localListen(mock)}`;
  let origin;
  let output = '';
  async function stopApp() {
    if (!app || app.exitCode !== null) return;
    const exited = once(app, 'exit');
    const kill = setTimeout(() => app.kill('SIGKILL'), 8000);
    kill.unref();
    app.kill('SIGTERM');
    await exited;
    clearTimeout(kill);
  }
  async function startApp(mode) {
    const port = await localPort();
    origin = `http://127.0.0.1:${port}`;
    output = '';
    const env = { ...process.env, NODE_ENV: 'test', DEMO_MODE: 'true', EXCHANGE_DEMO_FEATURES: 'false',
      DATABASE_URL: databaseUrl, PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: origin, SERVE_WEB_DIR: '',
      TELEGRAM_BOT_API_TEST_ORIGIN: fakeOrigin, TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_MODE: mode,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: process.env.HWFORAI_TELEGRAM_TEST_SMTP_PORT ?? '1025', SMTP_REQUIRE_TLS: 'false',
      SMTP_SECURE: 'false', MAIL_FROM: 'no-reply@example.test',
    };
    app = spawn(process.execPath, ['dist/main.js'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', text => { output += text; });
    app.stderr.on('data', text => { output += text; });
    await eventually(async () => {
      assert.equal(app.exitCode, null, output);
      return fetch(origin + '/api/v1/health').then(r => r.ok, () => false);
    }, () => 'Nest failed to start\n' + output.slice(-5500), 100000);
  }
  async function api(path, { method = 'GET', body, cookie, status = 200, headers = {} } = {}) {
    const response = await fetch(origin + '/api/v1' + path, {
      method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${result}`);
    return { data: result ? JSON.parse(result) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = (login, password) => api('/auth/login', { method: 'POST', body: { login, password } });
  const update = (body, status = 200, given = secret) => api('/telegram/webhook', {
    method: 'POST', status, body, headers: given ? { 'X-Telegram-Bot-Api-Secret-Token': given } : {},
  });
  const receipt = (condition, description) => eventually(() => calls.find(condition), description);
  const event = nextEvent();
  const write = async (chat, text, options) => update(event(chat, text, options));
  let callbackSeq = 4000;
  async function press(chat, message, data) {
    const id = `call_${++callbackSeq}`;
    await update({ update_id: callbackSeq, callback_query: { id, from: { id: chat }, data,
      message: { message_id: message.messageId, chat: { id: chat, type: 'private' } } } });
    return receipt(item => item.method === 'answerCallbackQuery' && item.body.callback_query_id === id, 'No callback acknowledgement');
  }
  const button = (message, text) => message.body.reply_markup.inline_keyboard.flat().find(key => key.text === text)?.callback_data;
  const notify = async (title, hold = false) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const n = new ExchangeNotifications(null, null, null);
      process.env.TELEGRAM_BOT_TOKEN = token;
      const id = await n.notify(client, sellerId, { kind: 'verification.document_rejected', title, body: 'Тестовый резерв.', channels: ['EMAIL'] });
      if (hold) await client.query("UPDATE notification_deliveries SET next_attempt_at=now()+interval '1 hour' WHERE notification_id=$1 AND channel='TELEGRAM'", [id]);
      await client.query('COMMIT');
      return id;
    } finally { delete process.env.TELEGRAM_BOT_TOKEN; client.release(); }
  };
  const delivery = async (id, channel) => (await db.query(`SELECT id,status,attempts,fallback_for,next_attempt_at<=now() AS due
    FROM notification_deliveries WHERE notification_id=$1 AND channel=$2`, [id, channel])).rows[0];

  await startApp('webhook');
  const seller = (await login('test1', 'test1')).cookie;
  const buyer = (await login('test2', 'test2')).cookie;
  const session = await login('admin', 'admin');
  const rotated = await api('/auth/credentials', { method: 'PATCH', cookie: session.cookie,
    body: { currentPassword: 'admin', newPassword: 'telegram-qa-admin-secret-029' } });
  const admin = rotated.cookie ?? session.cookie;
  const issue = async (cookie = seller) => new URL((await api('/me/telegram/link', { method: 'POST', cookie })).data.url).searchParams.get('start');

  await t.test('activation, owner-only health, secrets and binding token lifecycle', async () => {
    await api('/me/telegram/link', { cookie: seller, method: 'POST', status: 409 });
    await api('/me/telegram/link', { cookie: admin, method: 'POST', status: 403 });
    await api('/admin/telegram', { cookie: seller, status: 403 });
    await api('/admin/settings/feature_telegram', { cookie: admin, method: 'PUT', body: { value: true } });
    const webhook = await receipt(item => item.method === 'setWebhook', 'webhook missing');
    assert.equal(webhook.body.url, origin + '/api/v1/telegram/webhook');
    assert.equal(webhook.body.secret_token, secret);
    assert.deepEqual(webhook.body.allowed_updates, ['message', 'callback_query']);
    await eventually(async () => (await api('/me/telegram', { cookie: seller })).data.botUsername, 'getMe username unavailable');
    const health = await api('/admin/telegram', { cookie: admin });
    assert.equal(health.data.tokenConfigured, true);
    assert.ok(!JSON.stringify(health.data).includes(token));
    const stale = await issue();
    const latest = await issue();
    assert.notEqual(stale, latest);
    await api('/actions/' + latest, { status: 404 });
    for (const wrong of ['', 'bogus']) {
      const message = event(sellerChat, '/start ' + latest);
      assert.equal((await update(message, 401, wrong)).data, null);
      assert.equal((await db.query('SELECT 1 FROM telegram_updates WHERE update_id=$1', [message.update_id])).rowCount, 0);
    }
    await update(event(sellerChat, '/start ' + latest, { chat: { id: -100, type: 'group' } }));
    assert.equal((await api('/me/telegram', { cookie: seller })).data.linked, false);
    await write(sellerChat, '/start ' + stale);
    await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Ссылка устарела'), 'Old token rejection missing');
    const link = event(sellerChat, '/start ' + latest);
    await update(link);
    await update(link);
    await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Готово'), 'Link confirmation missing');
    assert.equal(calls.filter(item => item.method === 'sendMessage' && item.body.text.startsWith('Готово')).length, 1);
    const status = (await api('/me/telegram', { cookie: seller })).data;
    assert.equal(status.linked, true);
    assert.equal(status.username, 'fixture_tg');
    assert.ok(!JSON.stringify(status).includes(String(sellerChat)));
    const second = await issue(buyer);
    await write(sellerChat, '/start ' + second);
    await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Этот Telegram уже привязан'), 'Duplicate ownership rejected');
    await write(buyerChat, '/start ' + second);
    await eventually(async () => (await api('/me/telegram', { cookie: buyer })).data.linked, 'Second account did not bind');
  });

  await t.test('daily ask, fallback, forged callback, changed and withdrawn listings', async () => {
    const { rows: listings } = await db.query(`SELECT id FROM listings WHERE owner_id=$1 AND price_mode='FIXED'
      ORDER BY id LIMIT 3`, [sellerId]);
    assert.equal(listings.length, 3);
    await db.query("UPDATE listings SET status='ARCHIVED' WHERE owner_id=$1 AND id<>ALL($2::uuid[])", [sellerId, listings.map(row => row.id)]);
    await db.query(`UPDATE listings SET status='ACTIVE', asked_at=NULL, expires_at=now()+interval '10 days'
      WHERE id=ANY($1::uuid[])`, [listings.map(row => row.id)]);
    const hour = new Date().getUTCHours();
    const earlyTimezone = hour < 10 ? 'UTC' : hour < 20 ? 'Etc/GMT+10' : 'Etc/GMT-4';
    await db.query("UPDATE platform_settings SET value=to_jsonb($1::text) WHERE key='timezone'", [earlyTimezone]);
    await db.query("UPDATE platform_settings SET value='true'::jsonb WHERE key='feature_actuality'");
    const manual = await api('/admin/actuality/ask-now', { cookie: admin, method: 'POST' });
    assert.equal(manual.data.status, 'DONE');
    assert.ok(manual.data.asked >= 3);
    const ask = await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Актуально?') && String(item.body.chat_id) === String(sellerChat), 'Seller ask missing');
    const n = button(ask, 'Актуально').split(':')[1];
    const sent = await eventually(async () => (await delivery(n, 'TELEGRAM')).status === 'SENT' && await delivery(n, 'TELEGRAM'), 'Ask not recorded sent');
    const fallback = await delivery(n, 'EMAIL');
    assert.equal(fallback.status, 'SKIPPED');
    assert.equal(fallback.fallback_for, sent.id);
    const foreign = await press(buyerChat, ask, button(ask, 'Актуально'));
    assert.equal(foreign.body.text, 'Эта кнопка не для вас');
    const lock = await db.connect();
    let racing;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [sellerId]);
      racing = press(sellerChat, ask, button(ask, 'Актуально'));
      racing.catch(() => {});
      await eventually(async () => (await db.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE 'SELECT role,pd_consent_version,telegram_chat_id FROM users WHERE id=$1%'`)).rowCount,
        'Callback did not wait for the profile lock', 3000);
      await lock.query('UPDATE users SET telegram_chat_id=NULL,telegram_user_id=NULL WHERE id=$1', [sellerId]);
      await lock.query('COMMIT');
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    assert.equal((await racing).body.text, 'Telegram отвязан от профиля');
    await write(sellerChat, '/start ' + await issue());
    const approved = await press(sellerChat, ask, button(ask, 'Актуально'));
    assert.equal(approved.body.text, 'Подтверждено');
    await receipt(item => item.method === 'editMessageReplyMarkup' && item.body.message_id === ask.messageId, 'Keyboard not cleared');
    const replay = await press(sellerChat, ask, button(ask, 'Актуально'));
    assert.equal(replay.body.text, 'Уже отвечено');
    await write(sellerChat, '/status');
    const remaining = await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Ждут ответа: 2'), 'Status with open questions missing');
    await press(sellerChat, remaining, button(remaining, 'Изменилась цена или количество'));
    const prompt = await receipt(item => item.method === 'sendMessage' && item.body.reply_markup?.force_reply, 'Missing change dialog');
    await eventually(async () => (await db.query('SELECT 1 FROM telegram_dialogs WHERE chat_id=$1 AND prompt_message_id=$2',
      [sellerChat, prompt.messageId])).rowCount === 1, 'Change dialog did not record the reply message');
    await write(sellerChat, 'не понял');
    await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Не понял'), 'Invalid input must leave dialog active');
    await write(sellerChat, 'цена 1 750 000; количество 6', { reply_to_message: { message_id: prompt.messageId } });
    const { rowCount: edited } = await db.query("SELECT 1 FROM listings WHERE owner_id=$1 AND price=1750000 AND quantity=6", [sellerId]);
    assert.equal(edited, 1, JSON.stringify(calls.filter(item => item.method === 'sendMessage').at(-1)?.body));
    await write(sellerChat, '/status');
    const last = await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Ждут ответа: 1'), 'Status after edit missing');
    await press(sellerChat, last, button(last, 'Снято'));
    const reasons = await receipt(item => item.method === 'editMessageReplyMarkup' && item.body.message_id === last.messageId && button(item, 'Продано вне площадки'), 'Withdrawal reasons missing');
    const result = await press(sellerChat, last, button(reasons, 'Продано вне площадки'));
    assert.equal(result.body.text, 'Объявление снято');
    assert.equal((await db.query("SELECT 1 FROM listings WHERE id=ANY($1::uuid[]) AND status='ARCHIVED' AND archived_reason='SOLD_OUTSIDE'", [listings.map(row => row.id)])).rowCount, 1);
    assert.equal((await db.query("SELECT 1 FROM job_runs WHERE job='actuality.ask' AND slot NOT LIKE 'manual:%'")).rowCount, 0);
  });

  await t.test('The authorized Telegram recipient confirms disclosure and marks an earlier acquaintance', async () => {
    await api('/admin/settings/feature_disclosure_journal', { cookie: admin, method: 'PUT', body: { value: true } });
    await api('/admin/settings/disclosure_min_level', { cookie: admin, method: 'PUT', body: { value: 0 } });
    const { rows: [listing] } = await db.query("SELECT id FROM listings WHERE owner_id=$1 AND status='ACTIVE' ORDER BY id LIMIT 1", [sellerId]);
    const { data: chat } = await api('/chats', { cookie: buyer, method: 'POST', body: { listingId: listing.id }, status: 201 });
    await api('/chats/' + chat.id + '/reveal', { cookie: buyer, method: 'PATCH', body: { action: 'REQUEST', rulesAccepted: true } });
    const requested = await receipt(item => item.method === 'sendMessage' && item.body.text.startsWith('Запрос обмена контактами'), 'Disclosure request missing');
    assert.match(requested.body.text, /12 месяцев/);
    const accepted = await press(sellerChat, requested, button(requested, 'Принять обмен'));
    assert.equal(accepted.body.text, 'Обмен принят');
    assert.equal((await db.query('SELECT 1 FROM disclosures WHERE chat_id=$1', [chat.id])).rowCount, 1);
    const first = await receipt(item => item.method === 'sendMessage' && String(item.body.chat_id) === String(buyerChat) &&
      item.body.text.startsWith('Раскрытие R-'), 'First disclosure notice missing');
    const known = await press(buyerChat, first, button(first, 'Уже знакомы'));
    assert.equal(known.body.text, 'Подтверждено');
    assert.equal((await db.query(`SELECT 1 FROM disclosure_events e JOIN disclosures d ON d.id=e.disclosure_id
      WHERE d.chat_id=$1 AND e.type='ALREADY_KNOWN'`, [chat.id])).rowCount, 1);
  });

  await t.test('per-chat throttling, Retry-After, disabled binding and immediate fallback', async () => {
    const first = await notify('Ограничение чата номер один');
    const second = await notify('Ограничение чата номер два');
    const one = await receipt(item => item.body.text?.startsWith('Ограничение чата номер один'), 'First send missing');
    const two = await receipt(item => item.body.text?.startsWith('Ограничение чата номер два'), 'Second send missing');
    assert.ok(two.at - one.at >= 1095, `same chat spacing ${two.at - one.at}ms`);
    for (const id of [first, second]) await eventually(async () => (await delivery(id, 'TELEGRAM')).status === 'SENT', 'Delivery not recorded');

    failNext = { title: 'Повтор после ограничения', failure: { error_code: 429, parameters: { retry_after: 5 }, description: 'Retry later' } };
    const retry = await notify(failNext.title);
    await receipt(item => item.body.text?.startsWith('Повтор после ограничения'), 'No rate-limited send');
    await eventually(async () => !(await delivery(retry, 'TELEGRAM')).due, 'Retry was not postponed');
    assert.equal((await delivery(retry, 'TELEGRAM')).attempts, 0);
    await eventually(async () => (await delivery(retry, 'TELEGRAM')).status === 'SENT', 'Rate-limited send never retried');
    const spaced = calls.filter(item => item.body.text?.startsWith('Повтор после ограничения'));
    assert.ok(spaced[1].at - spaced[0].at >= 4990);

    const pending = await notify('Ожидание в очереди', true);
    failNext = { title: 'Бот заблокирован участником', failure: { error_code: 403, description: 'bot was blocked by the user' } };
    const blocked = await notify(failNext.title);
    await eventually(async () => (await delivery(blocked, 'TELEGRAM')).status === 'FAILED', 'Blocked status missing');
    assert.equal((await api('/me/telegram', { cookie: seller })).data.disabledReason, 'BOT_BLOCKED');
    assert.equal((await delivery(pending, 'TELEGRAM')).status, 'SKIPPED');
    assert.equal((await delivery(blocked, 'EMAIL')).due, true);
    assert.equal((await delivery(pending, 'EMAIL')).due, true);
    assert.equal((await db.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='telegram.disabled'", [sellerId])).rowCount, 1);
    await write(sellerChat, '/start ' + await issue());
    await eventually(async () => (await api('/me/telegram', { cookie: seller })).data.linked, 'Relink missing');
    const stop = await notify('Ожидает команды stop', true);
    await write(sellerChat, '/stop');
    assert.equal((await api('/me/telegram', { cookie: seller })).data.disabledReason, 'USER_STOP');
    assert.equal((await delivery(stop, 'TELEGRAM')).status, 'SKIPPED');
    assert.equal((await delivery(stop, 'EMAIL')).due, true);
    const emailOnly = await notify('Только почта после stop');
    assert.equal(await delivery(emailOnly, 'TELEGRAM'), undefined);
    assert.equal((await delivery(emailOnly, 'EMAIL')).due, true);
  });

  await t.test('polling uses its persistent offset and stores no incoming text', async () => {
    await stopApp();
    await db.query("INSERT INTO telegram_updates(update_id,kind,received_at) VALUES (1,'OTHER',now()-interval '8 days')");
    await db.query("DELETE FROM job_runs WHERE job='platform.cleanup'");
    await startApp('polling');
    await eventually(async () => !(await db.query('SELECT 1 FROM telegram_updates WHERE update_id=1')).rowCount,
      'Platform cleanup did not remove the old Telegram update');
    await receipt(item => item.method === 'deleteWebhook', 'Polling should clear webhook mode');
    const detail = (await api('/admin/telegram', { cookie: admin })).data;
    assert.equal(detail.mode, 'polling');
    const message = event(buyerChat, 'уникальный_текст_пользователя_не_сохранять');
    message.update_id = 10001;
    pendingUpdates.push(message, message);
    await eventually(async () => Number((await db.query('SELECT polling_offset FROM telegram_state')).rows[0].polling_offset) === 10002, 'Polling offset not persisted');
    assert.deepEqual((await db.query('SELECT kind,handled FROM telegram_updates WHERE update_id=10001')).rows,
      [{ kind: 'MESSAGE', handled: true }]);
    await receipt(item => item.method === 'sendMessage' && String(item.body.chat_id) === String(buyerChat) && item.body.text.includes('/help'), 'Help response missing');
    assert.ok(!output.includes(message.message.text));
    assert.ok(!output.includes(token));
  });
});
