import { ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StaffSession } from '../auth/auth.types';
import { appOrigin, demoMode, isProduction } from '../config';
import { DatabaseService, type Queryable } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { currencies, object } from '../market/market.inputs';
import { MatchingService } from '../matching/matching.service';
import type { PilotPeriod, StopRule } from '../pilot/pilot.settings';
import { telegramToken } from '../telegram/telegram-config';
import { OpsMonitor } from './ops-monitor';
import { preparedRules, RulesPublication } from './rules-publication';

type Actor = Pick<StaffSession<'ADMIN'>, 'id' | 'username' | 'role'> & { sessionHash?: string };
type Check = { id: string; ok: boolean; text: string };
type Values = Record<string, unknown>;
type Currency = typeof currencies[number];
type Corridor = { model_id: string; basis: string; min_usd: number; max_usd: number };
const labels: Record<string, string> = {
  'actuality.ask': 'Вопрос об актуальности', 'actuality.remind': 'Напоминание об актуальности',
  'actuality.sweep': 'Скрытие и архив', 'matching.recompute': 'Пересчёт совпадений',
  'matching.notify': 'Уведомления о совпадениях', 'notifications.deliver': 'Отправка писем',
  'deals.followups': 'Опросы по сделкам', 'deals.pair-open': 'Поиск повторных сделок в чатах',
  'deals.cleanup': 'Очистка незавершённых ручных сделок', 'catalog.pci': 'Обновление справочника карт',
  'chat.digest': 'Письма о сообщениях', 'staff.digest': 'Сводка оператору', 'rules.publish': 'Вступление правил в силу',
  'pilot.snapshot': 'Снимок показателей пробы', 'platform.cleanup': 'Очистка устаревших записей',
  'lots.detect': 'Обнаружение дублей', 'trust.recompute': 'Пересчёт рейтинга',
  'disputes.deadlines': 'Сроки рассмотрения споров', 'listings.owner-confirm-expire': 'Сроки подтверждения карточек',
};

export function operationalJobName(name: string) { return labels[name] ?? 'Служебная задача'; }

@Injectable()
export class TrialPreset implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings, private readonly matches: MatchingService,
    private readonly rules: RulesPublication, private readonly jobs: ExchangeJobs, private readonly notifications: ExchangeNotifications,
    private readonly monitor: OpsMonitor) {}

  onModuleInit() {
    this.jobs.onFailure(async (client, job, clock) => {
      if (!(await this.settings.get<{ failedJobs: boolean }>('ops_alerts', client)).failedJobs) return;
      await this.notifyStaff(client, 'ops.job_failed', 'Ошибка фоновой задачи',
        `Задача «${operationalJobName(job)}» завершилась ошибкой.`, 'ops.job_failed:' + job + ':' + clock.now.toISOString().slice(0, 13));
    });
  }

  async preview(rawRates?: unknown) {
    const before = await this.snapshot(this.db);
    const rates = rawRates === undefined ? before.fxRates as Values : object(rawRates);
    return this.previewFor(this.db, before, rates);
  }

  private async previewFor(client: Queryable, before: Values, rates: Values) {
    const page = await this.rules.page(client, 'rules');
    const { rows: [launch] } = await client.query<{
      testMailOk: boolean; policyActive: boolean; startsAt: Date | null; candidate: Date; trialDay: string; trialEnd: string;
    }>(`
      WITH local AS (
        SELECT (value#>>'{}') AS zone FROM platform_settings WHERE key='timezone'
      ), first_day AS (
        SELECT zone,now()+interval '72 hours' AS earliest,date_trunc('day',(now()+interval '72 hours') AT TIME ZONE zone)+
          interval '10 hours' AS local_start FROM local
      )
      SELECT s.test_mail_ok AS "testMailOk",
        EXISTS(SELECT 1 FROM site_content WHERE key='pd_policy' AND active) AS "policyActive",
        (SELECT starts_at FROM actuality_activation WHERE singleton) AS "startsAt",
        (local_start + CASE WHEN local_start AT TIME ZONE zone < earliest THEN interval '1 day' ELSE interval '0' END)
          AT TIME ZONE zone AS candidate, to_char(now() AT TIME ZONE zone,'YYYY-MM-DD') AS "trialDay",
        to_char((now() AT TIME ZONE zone)::date+13,'YYYY-MM-DD') AS "trialEnd"
      FROM ops_status s CROSS JOIN first_day WHERE s.singleton
    `);
    const settings = before.settings as Values;
    const checks: Check[] = [
      { id: 'rates', ok: currencies.every(currency => this.validRate(rates[currency])), text: 'Заданы положительные курсы всех шести валют' },
      { id: 'rules', ok: Boolean(page?.active && preparedRules(page.translations)), text: 'Опубликованы правила с реквизитами оператора' },
      { id: 'policy', ok: launch.policyActive && typeof settings.pd_policy_version === 'string' &&
        !/^0(?:\.|$)/.test(settings.pd_policy_version), text: 'Опубликована утверждённая политика обработки данных' },
      { id: 'third-party-letter', ok: (settings.third_party_letter as { approved?: boolean } | undefined)?.approved === true,
        text: 'Утверждён шаблон письма компаниям' },
      { id: 'smtp', ok: launch.testMailOk === true && (!process.env.MAIL_TRANSPORT || process.env.MAIL_TRANSPORT === 'smtp') &&
        Boolean(process.env.SMTP_HOST), text: 'Тестовое письмо отправлено через SMTP' },
    ];
    const next: Values = {
      registration_mode: 'INVITE', feature_invites: true, feature_disclosure_journal: true, feature_representation: true,
      feature_matching: true, feature_trust_rating: true, feature_listing_premoderation: true, feature_actuality: true,
      disclosure_min_level: 1, low_rating_threshold: 30,
      ...(telegramToken() ? { feature_telegram: true } : {}),
      disclosure_requires_verified_telegram: Boolean(telegramToken()),
    };
    const { rows: edited } = await client.query(`
      SELECT key FROM platform_settings WHERE key IN ('pilot_period','stop_rule') AND updated_by IS NOT NULL LIMIT 1
    `);
    if (!edited.length) {
      next.pilot_period = { from: launch.trialDay, to: launch.trialEnd } satisfies PilotPeriod;
      next.stop_rule = { date: launch.trialEnd, minLiveMatches: (settings.stop_rule as StopRule).minLiveMatches } satisfies StopRule;
    }
    const changes = [...Object.entries(next).map(([key, after]) => ({ key, before: settings[key], after })),
      ...currencies.map(currency => ({ key: 'fx.' + currency, before: (before.fxRates as Values)[currency], after: rates[currency] ?? null })),
      { key: 'price_corridors', before: before.corridors, after: await this.corridorCount(client) },
    ].filter(item => JSON.stringify(item.before) !== JSON.stringify(item.after));
    const firstActualityAt = settings.feature_actuality ? launch.startsAt ?? launch.candidate : launch.candidate;
    return { checks, changes, firstActualityAt, fxRates: rates, next,
      rulesDigest: createHash('sha256').update(JSON.stringify(page?.translations ?? {})).digest('hex') };
  }

  async apply(actor: Actor, rawRates: unknown) {
    const rates = object(rawRates);
    const via = actor.sessionHash ? 'ADMIN' : 'CLI';
    return this.db.transaction(async client => {
      if (actor.sessionHash) await lockTrustStaff(client, actor as StaffSession<'ADMIN'>);
      else {
        const result = await client.query("SELECT 1 FROM users WHERE id=$1 AND role='ADMIN' AND status='ACTIVE' AND NOT must_change_password FOR SHARE", [actor.id]);
        if (!result.rowCount) throw new UnauthorizedException('Администратор недоступен');
      }
      await client.query('SELECT pg_advisory_xact_lock(18403,130)');
      const before = await this.snapshot(client);
      const preview = await this.previewFor(client, before, rates);
      if (!preview.checks.every(check => check.ok)) {
        throw new ConflictException({ message: 'Пройдите предварительные проверки пробы', checks: preview.checks });
      }

      const { changes } = preview;
      for (const currency of currencies) await this.matches.setRateWith(client, actor, currency, { usdPerUnit: rates[currency] });
      const { pilot_period, stop_rule, ...flags } = preview.next;
      for (const [key, value] of Object.entries(flags)) await this.settings.putWith(client, actor as StaffSession<'ADMIN'>, key, value);
      if (pilot_period && stop_rule) {
        const previous = (before.settings as Values).stop_rule as StopRule;
        const period = pilot_period as PilotPeriod;
        const range = period.from > previous.date ? [['stop_rule', stop_rule], ['pilot_period', pilot_period]] as const
          : [['pilot_period', pilot_period], ['stop_rule', stop_rule]] as const;
        for (const [key, value] of range) await this.settings.putWith(client, actor as StaffSession<'ADMIN'>, key, value);
      }
      for (const row of this.corridors()) {
        const inserted = await client.query(`
          INSERT INTO price_corridors(model_id,basis,min_usd,max_usd,set_by) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (model_id,basis) DO NOTHING RETURNING model_id
        `, [row.model_id, row.basis, row.min_usd, row.max_usd, actor.id]);
        if (inserted.rowCount) await auditExchange(client, actor, 'price_corridor', row.model_id + ':' + row.basis, 'create', null, row);
      }
      const { rows: [previous] } = await client.query<{ id: string; digest: string }>(
        "SELECT id,after_data->>'rulesDigest' AS digest FROM preset_runs WHERE preset='TRIAL' ORDER BY id DESC LIMIT 1",
      );
      const after = await this.snapshot(client);
      if (previous && previous.digest === preview.rulesDigest && JSON.stringify(before) === JSON.stringify(after)) {
        return { presetRunId: previous.id, changes: [] };
      }
      const { rows: [run] } = await client.query<{ id: string }>(`
        INSERT INTO preset_runs(preset,applied_by,applied_via,before_data,after_data) VALUES ('TRIAL',$1,$2,$3,$4) RETURNING id
      `, [actor.id, via, JSON.stringify(this.auditSnapshot(before)), JSON.stringify({ ...this.auditSnapshot(after), rulesDigest: preview.rulesDigest })]);
      await auditExchange(client, actor, 'preset_runs', run.id, 'apply_trial', null, { count: changes.length, via });
      await this.notifyStaff(client, 'ops.trial_applied', 'Пресет «Проба» применён', 'Проверьте готовность к первым приглашениям.', 'ops.trial_applied:' + run.id);
      return { presetRunId: run.id, changes };
    });
  }

  async readiness() {
    const [preview, monitor, checks] = await Promise.all([
      this.preview(), this.monitor.status(),
      this.db.query<{ moderator: boolean; applied: boolean; bot: boolean; flags: Record<string, boolean> }>(`
        SELECT EXISTS(SELECT 1 FROM users WHERE role='MODERATOR' AND status='ACTIVE' AND email_verified_at IS NOT NULL
            AND NOT must_change_password) AS moderator,
          EXISTS(SELECT 1 FROM preset_runs WHERE preset='TRIAL') AS applied,
          EXISTS(SELECT 1 FROM telegram_state WHERE bot_username IS NOT NULL)
            AND EXISTS(SELECT 1 FROM platform_settings WHERE key='feature_telegram' AND value='true'::jsonb) AS bot,
          (SELECT jsonb_object_agg(key,checked) FROM readiness_attestations) AS flags
      `),
    ]);
    const { moderator, applied, bot, flags } = checks.rows[0];
    const has = (id: string) => Boolean(preview.checks.find(check => check.id === id)?.ok);
    const row = (id: string, ok: boolean, text: string, manual = false) => ({ id, ok, text, manual });
    return { rows: [
      row('https', isProduction() && appOrigin()?.startsWith('https://') === true, 'Настроен рабочий адрес HTTPS'),
      row('mailboxes', flags?.mailboxes === true, 'Письмо проверено в Gmail, Яндекс Почте и Mail.ru', true),
      row('policy', has('policy') && has('rules'), 'Политика обработки данных и правила опубликованы'),
      row('third-party', has('third-party-letter'), 'Шаблон для компаний утверждён'),
      row('preset', applied && has('rates') && !preview.changes.some(change => change.key === 'price_corridors'),
        'Пресет применён, курсы и ценовые ориентиры заданы'),
      row('first-invites', Number(preview.firstActualityAt) - Date.now() >= 72 * 3600 * 1000 || flags?.invitations === true,
        'Учтены 72 часа перед первым вопросом об актуальности', true),
      row('backup', monitor.backupReady, 'Копия свежая, восстановление проверено'),
      row('monitor', monitor.ok && flags?.monitor === true, 'Внешний мониторинг проверен', true),
      row('telegram', bot || flags?.email === true, 'Бот подключён или участники предупреждены о почте', true),
      row('moderator', moderator, 'Модератор подтвердил почту и сменил пароль'),
    ], firstActualityAt: preview.firstActualityAt, demo: demoMode() };
  }

  private async snapshot(client: Queryable): Promise<Values> {
    const { rows: [state] } = await client.query<Values>(`
      SELECT (SELECT jsonb_object_agg(key,value) FROM platform_settings WHERE key IN
        ('registration_mode','feature_invites','feature_disclosure_journal','feature_representation',
        'feature_matching','feature_trust_rating','feature_listing_premoderation','feature_actuality','feature_telegram',
        'disclosure_requires_verified_telegram','disclosure_min_level','low_rating_threshold','pilot_period','stop_rule',
        'rules_version','pd_policy_version','third_party_letter')) AS settings,
        (SELECT jsonb_object_agg(currency,usd_per_unit::text) FROM fx_rates) AS "fxRates",
        (SELECT count(*)::int FROM price_corridors) AS corridors
    `);
    return state;
  }

  private auditSnapshot(raw: Values) {
    const { third_party_letter: _letter, ...settings } = raw.settings as Values;
    return { ...raw, settings };
  }

  private corridors(): Corridor[] {
    return (JSON.parse(readFileSync(resolve(__dirname, '../../seeds/exchange_data/price_corridors.json'), 'utf8')) as { corridors: Corridor[] }).corridors;
  }

  private async corridorCount(client: Queryable) {
    const { rows: [row] } = await client.query<{ count: number }>(`
      SELECT ((SELECT count(*) FROM price_corridors) + count(*))::int AS count
      FROM jsonb_to_recordset($1) AS seed(model_id text,basis text)
      WHERE NOT EXISTS(SELECT 1 FROM price_corridors p WHERE p.model_id=seed.model_id AND p.basis=seed.basis)
    `, [JSON.stringify(this.corridors())]);
    return row.count;
  }

  private validRate(rate: unknown): rate is number | string {
    return typeof rate === 'number' || typeof rate === 'string' ? /^\d{1,10}(\.\d{1,8})?$/.test(String(rate)) && Number(rate)>0 : false;
  }

  private async notifyStaff(client: Queryable, kind: string, title: string, body: string, dedupeKey: string) {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role IN ('ADMIN','MODERATOR') AND status='ACTIVE' AND email_verified_at IS NOT NULL ORDER BY id",
    );
    for (const { id } of rows) await this.notifications.notify(client, id, { kind, title, body, dedupeKey });
  }
}
