import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

const origin = process.env.HWFORAI_OPS_TEST_URL;
const database = process.env.HWFORAI_OPS_TEST_DATABASE_URL;
const token = process.env.OPS_MONITOR_TOKEN;
const mailpit = process.env.MAILPIT_URL;
const cleanRules = 'Оператор площадки hwforai, тестовая организация. Участники публикуют достоверные сведения о товарах и используют раскрытые контакты для обсуждения поставки. Стороны могут обратиться к модератору через раздел сделок.';

async function call(path, status, { method = 'GET', body, session, bearer } = {}) {
  const response = await fetch(origin + path, { method, headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(session ? { Cookie: session } : {}),
    ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, path + ' ' + JSON.stringify(data));
  return { data, session: response.headers.get('set-cookie')?.split(';')[0] };
}

test('launch operations validate prerequisites, scope staff access, instrument mail and preserve a volume-compatible audit', async t => {
  assert.ok(origin && database && token && mailpit, 'Configure a disposable ops QA application, PostgreSQL, SMTP and token');
  const pool = new pg.Pool({ connectionString: database });
  t.after(() => pool.end());

  const initial = await call('/auth/login', 200, { method: 'POST', body: { login: 'admin', password: 'admin' } });
  const rotated = await call('/auth/credentials', 200, { method: 'PATCH', session: initial.session, body: {
    currentPassword: 'admin', newPassword: 'Ops-Admin-QA-' + randomBytes(5).toString('hex') + '!',
  } });
  const session = rotated.session ?? initial.session;
  const write = (path, body, method = 'POST') => ({ session, method, body });
  const get = async path => (await call(path, 200, { session })).data;

  const incomplete = await get('/admin/presets/trial');
  assert.ok(incomplete.checks.some(row => row.id === 'policy' && !row.ok));
  assert.ok(incomplete.checks.some(row => row.id === 'rules' && !row.ok));
  assert.ok(incomplete.checks.some(row => row.id === 'smtp' && !row.ok));
  assert.deepEqual((await call('/admin/presets/trial', 409, write('/admin/presets/trial', {fxRates: {}}))).data.checks,
    incomplete.checks.map(row => row.id === 'rates' ? { ...row, ok: false } : row));

  const draft = (await get('/admin/content')).find(page => page.key === 'rules_draft');
  assert.equal(draft.active, false);
  const savedDraft = (await call('/admin/content/rules_draft', 200, write('', {
    translations: { ru: { title: 'Заготовка правил', body: cleanRules + ' Новая редакция.' } }, active: true,
  }, 'PUT'))).data;
  assert.equal(savedDraft.active, false);
  await call('/admin/content/rules', 200, write('', {
    translations: { ru: { title: 'Правила площадки', body: cleanRules } }, active: true,
  }, 'PUT'));
  await call('/admin/content/pd_policy', 200, write('', {
    translations: { ru: { title: 'Политика обработки данных', body: cleanRules } }, active: true,
  }, 'PUT'));
  await call('/admin/settings/pd_policy_version', 200, write('', { value: '1.0' }, 'PUT'));

  const letter = { subject: 'Тестовое письмо принципалу', body: 'Хорошего дня. Для подтверждения используйте {link}. Политика: {policyUrl}. Отказ от писем: {optOutUrl}.' };
  await call('/admin/settings/third_party_letter', 200, write('', { value: { ...letter, approved: false } }, 'PUT'));
  await call('/admin/settings/third_party_letter', 200, write('', { value: { ...letter, approved: true } }, 'PUT'));
  const recipient = 'launch-check-' + randomBytes(6).toString('hex') + '@example.test';
  assert.equal((await call('/admin/mail/test', 200, write('', { to: recipient }))).data.ok, true);
  const search = new URLSearchParams({ query: 'to:' + recipient });
  const inbox = await fetch(mailpit + '/api/v1/search?' + search).then(response => response.json());
  assert.ok(inbox.messages.some(message => message.Subject.includes('тест почты')));

  const checked = await get('/admin/presets/trial');
  const fxRates = { ...checked.fxRates, KZT: '0.002', USD: '1' };
  const result = (await call('/admin/presets/trial', 201, write('', { fxRates }))).data;
  assert.ok(result.presetRunId);
  const repeat = (await call('/admin/presets/trial', 201, write('', { fxRates }))).data;
  assert.equal(repeat.presetRunId, result.presetRunId);
  const settings = Object.fromEntries((await get('/admin/settings')).map(({ key, value }) => [key, value]));
  assert.equal(settings.registration_mode, 'INVITE');
  assert.equal(settings.feature_actuality, true);
  assert.equal(settings.feature_listing_premoderation, true);
  assert.equal(settings.disclosure_min_level, 1);
  const { rows: [counts] } = await pool.query(`
    SELECT (SELECT count(*)::int FROM preset_runs) AS presets,(SELECT count(*)::int FROM price_corridors) AS corridors,
      (SELECT round(extract(epoch FROM (starts_at-now()))/3600)::int FROM actuality_activation WHERE singleton) AS "activationHours"
  `);
  assert.equal(counts.presets, 1);
  assert.ok(counts.corridors >= 10 && counts.activationHours >= 72);
  await pool.query("UPDATE price_corridors SET max_usd=400000 WHERE model_id='hgx-h200-8' AND basis='SELLER_WAREHOUSE'");
  await call('/admin/presets/trial', 201, write('', { fxRates }));
  const { rows: [corridor] } = await pool.query("SELECT max_usd::int AS max FROM price_corridors WHERE model_id='hgx-h200-8' AND basis='SELLER_WAREHOUSE'");
  assert.equal(corridor.max, 400000);

  const future = days => new Date(Date.now() + days * 86_400_000).toISOString();
  await call('/admin/rules/schedule', 400, write('', { version: '2.0', effectiveAt: future(3) }));
  await call('/admin/rules/schedule', 201, write('', { version: '2.0', effectiveAt: future(8) }));
  assert.equal((await get('/admin/rules/schedule')).current, settings.rules_version);
  await pool.query("UPDATE scheduled_rules SET effective_at=now()-interval '1 minute'");
  await call('/admin/jobs/rules.publish/run', 200, write('', {}));
  assert.equal((await get('/admin/rules/schedule')).current, '2.0');
  const pages = (await call('/content', 200)).data;
  assert.ok(pages.some(row => row.key === 'rules' && row.translations.ru.body.includes('Новая редакция')));
  assert.ok(!pages.some(row => row.key === 'rules_draft'));

  const moderatorToken = randomBytes(32).toString('hex');
  const { rows: [moderator] } = await pool.query(`
    INSERT INTO users(username,display_name,email,password_hash,role,email_verified_at)
    VALUES ('opsqa','Операционный тест','ops-qa@example.test','qa-non-password','MODERATOR',now()) RETURNING id
  `);
  const { createHash } = await import('node:crypto');
  await pool.query('INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval \'1 hour\')',
    [moderator.id, createHash('sha256').update(moderatorToken).digest('hex')]);
  const moderatorSession = 'hwforai_session=' + moderatorToken;
  const jobs = (await call('/admin/jobs/available', 200, { session: moderatorSession })).data.items;
  assert.equal(jobs.find(row => row.name === 'actuality.sweep').canRun, true);
  assert.equal(jobs.find(row => row.name === 'catalog.pci').canRun, false);
  const sweep = await call('/admin/jobs/actuality.sweep/run', 200, { method: 'POST', session: moderatorSession });
  assert.ok(sweep.data.jobRunId);
  await call('/admin/jobs/actuality.sweep/run', 429, { method: 'POST', session: moderatorSession });
  await call('/admin/jobs/catalog.pci/run', 403, { method: 'POST', session: moderatorSession });
  await call('/admin/readiness', 403, { session: moderatorSession });
  assert.ok((await get('/admin/jobs?job=actuality.sweep')).items.some(row => row.manual && row.manualBy === 'Операционный тест'));

  const { rows: [failed] } = await pool.query(`
    INSERT INTO exchange_email_outbox(recipient,subject,body,status,attempts,error,last_attempt_at)
    VALUES ('iv@example.test','HIDDEN SUBJECT','HIDDEN BODY','FAILED',5,'Тайм-аут соединения',now()) RETURNING id
  `);
  const path = '/admin/mail-queue?source=outbox&status=FAILED';
  const masked = (await call(path, 200, { session: moderatorSession })).data.items.find(row => row.id === failed.id);
  assert.equal(masked.recipient, 'i***@example.test');
  assert.equal((await get(path)).items.find(row => row.id === failed.id).recipient, 'iv@example.test');
  assert.doesNotMatch(JSON.stringify(masked), /HIDDEN/);
  await call('/admin/mail-queue/outbox/' + failed.id + '/retry', 200, { method: 'POST', session: moderatorSession });
  await call('/admin/mail-queue/outbox/' + failed.id + '/retry', 409, { method: 'POST', session: moderatorSession });

  await call('/health/ops', 401);
  await call('/health/ops', 503, { bearer: token });
  await call('/health/ops/backup', 204, { method: 'POST', bearer: token, body: { ok: true, finishedAt: future(-1.125), sizeBytes: 30, diskFreePercent: 52 } });
  const oldBackup = (await call('/health/ops', 503, { bearer: token })).data;
  assert.ok(oldBackup.lastBackupAgeHours >= 27);
  await call('/health/ops/backup', 204, { method: 'POST', bearer: token, body: { ok: true, finishedAt: future(0), sizeBytes: 123, diskFreePercent: 58 } });
  await call('/health/ops/backup', 204, { method: 'POST', bearer: token, body: { ok: true, kind: 'RESTORE', finishedAt: future(0) } });
  assert.equal((await get('/admin/readiness')).rows.find(row => row.id === 'backup').ok, true);
  await pool.query("INSERT INTO job_runs(job,slot,status,finished_at) VALUES ('test.failed','unique','FAILED',now())");
  assert.equal((await call('/health/ops', 503, { bearer: token })).data.failedJobsLastHour, 1);
});
