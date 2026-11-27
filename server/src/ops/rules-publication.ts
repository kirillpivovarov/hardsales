import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { StaffSession } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs } from '../exchange/jobs';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { object, str } from '../market/market.inputs';

const minimumNoticeMs = 7 * 24 * 60 * 60 * 1000;
const placeholder = /\[(?:НАЗВАНИЕ ПЛОЩАДКИ|ВЕРСИЯ|ДАТА|ЮРЛИЦО ПЛОЩАДКИ|АДРЕС|КОНТАКТ|ССЫЛКА)\]/;
const oldDraft = 'Публикуйте достоверные сведения об оборудовании и условиях поставки.';
type Translations = Record<string, { title: string; body: string }>;
type Schedule = { version: string; effective_at: Date; translations: Translations; scheduled_by: string };
type RulesActor = Pick<StaffSession<'ADMIN'>, 'id' | 'username' | 'role'>;

export function preparedRules(translations?: Translations) {
  const text = translations?.ru?.body?.trim();
  return Boolean(text && text.length >= 100 && !placeholder.test(text) && !text.startsWith(oldDraft));
}

@Injectable()
export class RulesPublication implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs, private readonly notifications: ExchangeNotifications) {}

  onModuleInit() {
    this.jobs.register({ name: 'rules.publish', lock: 27, run: client => this.publish(client) });
  }

  async page(client: Queryable, key: 'rules' | 'rules_draft') {
    const { rows: [page] } = await client.query<{ translations: Translations; active: boolean }>(
      'SELECT translations,active FROM site_content WHERE key=$1', [key],
    );
    return page;
  }

  async status() {
    const { rows: [pending] } = await this.db.query<{ version: string; effectiveAt: Date }>(
      'SELECT version,effective_at AS "effectiveAt" FROM scheduled_rules WHERE singleton',
    );
    return { current: await this.settings.get<string>('rules_version'), pending, minimumNoticeDays: 7 };
  }

  async schedule(actor: StaffSession<'ADMIN'>, input: unknown) {
    const data = object(input);
    const version = str(data.version, 'Версия правил', 1, 32);
    const rawTime = typeof data.effectiveAt === 'string' ? new Date(data.effectiveAt) : new Date(NaN);
    if (!Number.isFinite(rawTime.getTime()) || rawTime.getTime() < Date.now() + minimumNoticeMs) {
      throw new BadRequestException('Укажите дату вступления в силу не раньше чем через 7 дней');
    }
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      const draft = await this.page(client, 'rules_draft');
      if (!draft || !preparedRules(draft.translations)) throw new ConflictException('Заполните реквизиты и текст в заготовке правил');
      await this.plan(client, actor, version, rawTime, draft.translations);
      return { version, effectiveAt: rawTime };
    });
  }

  async plan(client: PoolClient, actor: RulesActor, version: string, effectiveAt: Date, translations: Translations) {
    const { rows: [current] } = await client.query<{ value: string }>(
      "SELECT value FROM platform_settings WHERE key='rules_version' FOR UPDATE",
    );
    if (version === current.value) throw new ConflictException('Укажите новую версию правил');
    const { rowCount } = await client.query(`
      INSERT INTO scheduled_rules(version,effective_at,translations,scheduled_by)
      VALUES ($1,$2,$3,$4) ON CONFLICT (singleton) DO NOTHING
    `, [version, effectiveAt, JSON.stringify(translations), actor.id]);
    if (!rowCount) throw new ConflictException('Вступление новой версии правил уже запланировано');
    const zone = await this.settings.get<string>('timezone', client);
    const date = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, dateStyle: 'long' }).format(effectiveAt);
    const { rows } = await client.query<{ id: string }>(`
      SELECT id FROM users WHERE role IN ('BUYER','SELLER') AND status='ACTIVE' AND email_verified_at IS NOT NULL ORDER BY id
    `);
    for (const { id } of rows) await this.notifications.notify(client, id, {
      kind: 'rules.scheduled', title: 'Изменение правил площадки',
      body: `Правила площадки меняются с ${date}. Ознакомьтесь с новой версией до вступления в силу.`,
      actions: [{ label: 'Новая версия правил', href: '/info/rules_upcoming' }],
      channels: ['EMAIL'], dedupeKey: 'rules.scheduled:' + version,
    });
    await client.query(`
      INSERT INTO site_content(key,translations,active) VALUES ('rules_upcoming',$1,true)
      ON CONFLICT (key) DO UPDATE SET translations=EXCLUDED.translations,active=true,updated_at=now()
    `, [JSON.stringify(translations)]);
    await auditExchange(client, actor, 'settings', 'rules_version', 'scheduled', { version: current.value }, { version, effectiveAt });
  }

  private async publish(client: PoolClient) {
    // Keep the same lock order as publication scheduling and account acceptance.
    const { rows: [current] } = await client.query<{ value: string }>(
      "SELECT value FROM platform_settings WHERE key='rules_version' FOR UPDATE",
    );
    const { rows: [scheduled] } = await client.query<Schedule>(
      'DELETE FROM scheduled_rules WHERE singleton AND effective_at <= now() RETURNING *',
    );
    if (!scheduled) return;
    const { rows: [actor] } = await client.query<RulesActor>("SELECT id,username,role FROM users WHERE id=$1 AND role='ADMIN'",
      [scheduled.scheduled_by]);
    await client.query(`
      INSERT INTO site_content(key,translations,active) VALUES ('rules',$1,true)
      ON CONFLICT (key) DO UPDATE SET translations=EXCLUDED.translations,active=true,updated_at=now()
    `, [JSON.stringify(scheduled.translations)]);
    await client.query("UPDATE platform_settings SET value=to_jsonb($1::text),updated_at=now(),updated_by=$2 WHERE key='rules_version'",
      [scheduled.version, scheduled.scheduled_by]);
    if (actor) await auditExchange(client, actor, 'settings', 'rules_version', 'published',
      { version: current.value }, { version: scheduled.version });
  }
}
