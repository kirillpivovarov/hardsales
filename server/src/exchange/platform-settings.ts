import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { StaffSession } from '../auth/auth.types';
import { demoMode } from '../config';
import { DatabaseService, type Queryable } from '../database/database.service';
import { integer, object, oneOf, slug, str } from '../market/market.inputs';
import { thirdPartyLetterSetting } from '../privacy/policy';
import { validatePilotSetting } from '../pilot/pilot.settings';
import { auditExchange } from './audit';
import { staffInstantKinds } from './notification-queues';
import { lockTrustStaff } from './trust-access';

export type SettingRow = { key: string; value: unknown; updatedAt: Date };
type ChangeHook = (client: PoolClient, before: unknown, after: unknown) => Promise<void>;

@Injectable()
export class PlatformSettings {
  private readonly hooks = new Map<string, ChangeHook[]>();

  constructor(private readonly db: DatabaseService) {}

  async get<T>(key: string, db: Queryable = this.db): Promise<T> {
    const result = await db.query<{ value: T }>('SELECT value FROM platform_settings WHERE key = $1', [key]);
    if (!result.rows[0]) throw new NotFoundException('Неизвестная настройка');
    return result.rows[0].value;
  }

  async enabled(key: string, db: Queryable = this.db): Promise<boolean> {
    return (await this.get<unknown>(key, db)) === true;
  }

  async all(publicOnly = false): Promise<SettingRow[]> {
    return (await this.db.query<SettingRow>(`
      SELECT key, value, updated_at AS "updatedAt" FROM platform_settings
      WHERE NOT $1 OR left(key, 8) = 'feature_' OR key IN ('rules_version', 'registration_mode', 'timezone')
      ORDER BY key
    `, [publicOnly])).rows;
  }

  onChange(key: string, hook: ChangeHook): void {
    this.hooks.set(key, [...(this.hooks.get(key) ?? []), hook]);
  }

  async put(actor: StaffSession<'ADMIN'>, key: string, value: unknown): Promise<SettingRow> {
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      return this.putWith(client, actor, key, value);
    });
  }

  async putWith(client: PoolClient, actor: StaffSession<'ADMIN'>, key: string, value: unknown): Promise<SettingRow> {
    if (key === 'pilot_period' || key === 'stop_rule') {
      await client.query("SELECT key FROM platform_settings WHERE key IN ('pilot_period','stop_rule') ORDER BY key FOR UPDATE");
    }
    const before = (await client.query<SettingRow>(
      'SELECT key, value, updated_at AS "updatedAt" FROM platform_settings WHERE key = $1 FOR UPDATE', [key],
    )).rows[0];
    if (!before) throw new NotFoundException('Неизвестная настройка');
    const next = await this.validate(client, actor, key, value, before.value);
    if (JSON.stringify(before.value) === JSON.stringify(next)) return before;
    const { rows: [after] } = await client.query<SettingRow>(`
      UPDATE platform_settings SET value=$2, updated_by=$3, updated_at=now() WHERE key=$1
      RETURNING key, value, updated_at AS "updatedAt"
    `, [key, JSON.stringify(next), actor.id]);
    for (const hook of this.hooks.get(key) ?? []) await hook(client, before.value, after.value);
    await auditExchange(client, actor, 'settings', key, 'update', { value: before.value }, { value: after.value });
    return after;
  }

  private async validate(client: PoolClient, actor: StaffSession<'ADMIN'>, key: string, value: unknown, before: unknown): Promise<unknown> {
    if (key.startsWith('feature_') || key === 'disclosure_requires_verified_telegram') {
      if (typeof value !== 'boolean') throw new BadRequestException('Настройка должна быть логической');
      return value;
    }
    if (key === 'registration_mode') return oneOf(value, ['OPEN', 'INVITE'], 'Режим регистрации');
    if (key === 'rules_version') {
      if (!demoMode()) throw new BadRequestException('Запланируйте версию правил в разделе «Настройки биржи».');
      return str(value, 'Версия правил', 1, 32);
    }
    if (key === 'ops_alerts') {
      const alert = object(value);
      if (typeof alert.failedJobs !== 'boolean') throw new BadRequestException('Укажите, нужно ли сообщать об ошибках задач');
      return { failedJobs: alert.failedJobs, failedEmailsPerHour: integer(alert.failedEmailsPerHour, 'Ошибки писем за час', 1, 1000) };
    }
    if (key === 'pd_policy_version') return str(value, 'Версия политики', 1, 32);
    if (key === 'third_party_letter') return thirdPartyLetterSetting(value, before, actor, new Date());
    if (key === 'disclosure_min_level') return integer(value, 'Уровень', 0, 2);
    if (key === 'low_rating_threshold') return integer(value, 'Порог рейтинга', 0, 100);
    if (key === 'staff_digest_hour') return integer(value, 'Час сводки для модераторов', 0, 23);
    if (key === 'staff_instant_kinds') {
      if (!Array.isArray(value) || value.length > staffInstantKinds.length) throw new BadRequestException('Укажите виды срочных уведомлений');
      return [...new Set(value.map(entry => oneOf(entry, staffInstantKinds, 'Вид уведомления')))];
    }
    if (key === 'model_required_categories') {
      if (!Array.isArray(value) || value.length > 100) throw new BadRequestException('Укажите список категорий');
      const categories = [...new Set(value.map(entry => slug(entry, 'Категория')))];
      const { rows } = await client.query(`
        WITH RECURSIVE model_categories AS (
          SELECT DISTINCT c.id,c.slug FROM categories c JOIN hardware_models m ON m.category_slug = c.slug
          UNION SELECT c.id,c.slug FROM categories c JOIN model_categories parent ON parent.id = c.parent_id
        )
        SELECT slug FROM model_categories WHERE slug = ANY($1::text[])
      `, [categories]);
      if (rows.length !== categories.length) throw new BadRequestException('Для выбранной категории недоступен справочник моделей');
      return categories;
    }
    if (key === 'near_miss_max_failures') return integer(value, 'Число расхождений', 1, 3);
    if (key === 'near_miss_price_over' || key === 'lot_price_tolerance') {
      const [min, max] = key === 'near_miss_price_over' ? [0.05, 1] : [0, 0.25];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new BadRequestException(`Укажите долю от ${min} до ${max}`);
      }
      return value;
    }
    if (key === 'timezone') {
      const timezone = str(value, 'Часовой пояс', 1, 80);
      const { rows } = await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
      if (!rows.length) throw new BadRequestException('Неизвестный часовой пояс');
      return timezone;
    }
    if (key === 'catalog_sync_vendors' && Array.isArray(value) && value.length > 0 && value.length <= 30 &&
      value.every(entry => typeof entry === 'string' && /^[a-f0-9]{4}$/.test(entry))) return [...new Set(value)];
    const pilot = await validatePilotSetting(client, key, value);
    if (pilot !== undefined) return pilot;
    throw new BadRequestException('Недопустимое значение настройки');
  }
}
