import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { StaffSession } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { integer, oneOf, str } from '../market/market.inputs';
import { auditExchange } from './audit';
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
      const before = (await client.query<SettingRow>(
        'SELECT key, value, updated_at AS "updatedAt" FROM platform_settings WHERE key = $1 FOR UPDATE', [key],
      )).rows[0];
      if (!before) throw new NotFoundException('Неизвестная настройка');
      const next = await this.validate(client, key, value);
      if (JSON.stringify(before.value) === JSON.stringify(next)) return before;
      const { rows: [after] } = await client.query<SettingRow>(`
        UPDATE platform_settings SET value=$2, updated_by=$3, updated_at=now() WHERE key=$1
        RETURNING key, value, updated_at AS "updatedAt"
      `, [key, JSON.stringify(next), actor.id]);
      for (const hook of this.hooks.get(key) ?? []) await hook(client, before.value, after.value);
      await auditExchange(client, actor, 'settings', key, 'update', { value: before.value }, { value: after.value });
      return after;
    });
  }

  private async validate(client: PoolClient, key: string, value: unknown): Promise<unknown> {
    if (key.startsWith('feature_')) {
      if (typeof value !== 'boolean') throw new BadRequestException('Настройка должна быть логической');
      return value;
    }
    if (key === 'registration_mode') return oneOf(value, ['OPEN', 'INVITE'], 'Режим регистрации');
    if (key === 'rules_version') return str(value, 'Версия правил', 1, 32);
    if (key === 'disclosure_min_level') return integer(value, 'Уровень', 0, 2);
    if (key === 'low_rating_threshold') return integer(value, 'Порог рейтинга', 0, 100);
    if (key === 'timezone') {
      const timezone = str(value, 'Часовой пояс', 1, 80);
      const { rows } = await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
      if (!rows.length) throw new BadRequestException('Неизвестный часовой пояс');
      return timezone;
    }
    if (key === 'catalog_sync_vendors' && Array.isArray(value) && value.length > 0 && value.length <= 30 &&
      value.every(entry => typeof entry === 'string' && /^[a-f0-9]{4}$/.test(entry))) return [...new Set(value)];
    throw new BadRequestException('Недопустимое значение настройки');
  }
}
