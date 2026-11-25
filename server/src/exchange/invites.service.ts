import {
  ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ParticipantRole, StaffSession } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { escapedSearch, integer, object, oneOf, pageParams, str, uuid } from '../market/market.inputs';
import { auditExchange } from './audit';
import { ExchangeNotifications } from './notifications';
import { PlatformSettings } from './platform-settings';

export type RegistrationMode = 'OPEN' | 'INVITE';
export const INVALID_INVITE = 'Код приглашения не найден или уже использован';
export const INVITE_NO_LONGER_AVAILABLE = 'Код приглашения уже использован. Попросите новый у модератора';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const invitePattern = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const states = ['OPEN', 'USED', 'REVOKED', 'EXPIRED'] as const;
const participantRoles = ['BUYER', 'SELLER'] as const;
const inviteStatus = `CASE WHEN i.used_by IS NOT NULL THEN 'USED' WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
  WHEN i.expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE 'OPEN' END`;
const inviteColumns = `i.id, i.code, i.note, i.preset_role AS "presetRole", i.created_at AS "createdAt",
  i.expires_at AS "expiresAt", i.revoked_at AS "revokedAt", i.used_at AS "usedAt",
  ${inviteStatus} AS status,
  CASE WHEN u.id IS NOT NULL THEN jsonb_build_object(
    'id', u.id, 'username', u.username, 'displayName', u.display_name
  ) END AS "usedBy"`;

export interface AvailableInvite {
  id: string;
  code: string;
  preset_role: ParticipantRole | null;
}

export function normalizeInviteCode(input: string): string {
  const compact = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function createCode(): string {
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}`;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications,
  ) {}

  async registration(db: Queryable = this.db): Promise<{ enabled: boolean; mode: RegistrationMode }> {
    const [enabled, configuredMode] = await Promise.all([
      this.settings.enabled('feature_invites', db),
      this.settings.get<RegistrationMode>('registration_mode', db),
    ]);
    return { enabled, mode: enabled && configuredMode === 'INVITE' ? 'INVITE' : 'OPEN' };
  }

  async lockRegistration(client: PoolClient): Promise<{ enabled: boolean; mode: RegistrationMode }> {
    await client.query(`
      SELECT key FROM platform_settings WHERE key IN ('feature_invites','registration_mode') ORDER BY key FOR SHARE
    `);
    return this.registration(client);
  }

  async available(input: string): Promise<AvailableInvite | undefined> {
    const code = normalizeInviteCode(input);
    if (!invitePattern.test(code)) return undefined;
    const { rows } = await this.db.query<AvailableInvite>(`
      SELECT id, code, preset_role FROM invites WHERE code = $1 AND used_by IS NULL AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
    `, [code]);
    return rows[0];
  }

  async lockAvailable(client: PoolClient, id: string, role: ParticipantRole): Promise<AvailableInvite> {
    const { rows: [invite] } = await client.query<AvailableInvite>(`
      SELECT id, code, preset_role FROM invites WHERE id = $1 AND used_by IS NULL AND revoked_at IS NULL
        AND expires_at > clock_timestamp() FOR UPDATE
    `, [id]);
    if (!invite || (invite.preset_role && invite.preset_role !== role)) {
      throw new ConflictException(INVITE_NO_LONGER_AVAILABLE);
    }
    return invite;
  }

  async consume(client: PoolClient, invite: AvailableInvite, userId: string, nickname: string): Promise<void> {
    const changed = await client.query(`
      UPDATE invites SET used_by = $2, used_at = now() WHERE id = $1 AND used_by IS NULL
        AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING created_by
    `, [invite.id, userId]);
    if (!changed.rowCount) throw new ConflictException(INVITE_NO_LONGER_AVAILABLE);
    await this.notifications.notify(client, changed.rows[0].created_by, {
      kind: 'invite.used',
      title: `Приглашение ${invite.code} использовано: ${nickname}`,
      body: 'Новый участник подтвердил почту.',
      payload: { inviteId: invite.id, userId },
      dedupeKey: `invite.used:${invite.id}`,
      channels: [],
    });
  }

  async list(query: Record<string, unknown>) {
    const status = query.status ? oneOf(query.status, states, 'Статус приглашения') : null;
    const search = query.q ? escapedSearch(query.q) : null;
    const { page, limit, offset } = pageParams(query);
    const match = `FROM invites i LEFT JOIN users u ON u.id = i.used_by
      WHERE ($1::text IS NULL OR (${inviteStatus}) = $1)
        AND ($2::text IS NULL OR i.code ILIKE $2 OR i.note ILIKE $2 OR u.display_name ILIKE $2 OR u.username ILIKE $2)`;
    const [items, total] = await Promise.all([
      this.db.query(`SELECT ${inviteColumns} ${match} ORDER BY i.created_at DESC, i.id DESC LIMIT $3 OFFSET $4`,
        [status, search, limit, offset]),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total ${match}`, [status, search]),
    ]);
    return { items: items.rows, total: total.rows[0].total, page, limit };
  }

  async create(actor: StaffSession<'ADMIN'>, raw: unknown) {
    const input = object(raw);
    const count = integer(input.count, 'Количество приглашений', 1, 50);
    const note = input.note === undefined ? '' : str(input.note, 'Заметка', 0, 200);
    const presetRole = input.presetRole == null ? null : oneOf(input.presetRole, participantRoles, 'Роль');
    const expiresInDays = input.expiresInDays === undefined ? 30 : integer(input.expiresInDays, 'Срок действия', 1, 90);
    return this.db.transaction(async (client) => {
      const current = await this.lockAdmin(client, actor);
      const items = [];
      for (let index = 0; index < count; index += 1) {
        items.push(await this.createOne(client, actor.id, note, presetRole, expiresInDays));
      }
      await auditExchange(client, current, 'invites', items[0].id, 'created', null, {
        count, presetRole, expiresInDays, inviteIds: items.map((item) => item.id),
      });
      return { items };
    });
  }

  async revoke(actor: StaffSession<'ADMIN'>, inputId: string, raw: unknown) {
    const id = uuid(inputId);
    const reason = str(object(raw).reason, 'Причина', 3, 500);
    return this.db.transaction(async (client) => {
      const current = await this.lockAdmin(client, actor);
      const { rows: [invite] } = await client.query<{ status: typeof states[number] }>(`
        SELECT ${inviteStatus} AS status FROM invites i WHERE i.id = $1 FOR UPDATE
      `, [id]);
      if (!invite) throw new NotFoundException('Приглашение не найдено');
      if (invite.status === 'USED') throw new ConflictException('Приглашение уже использовано');
      if (invite.status === 'EXPIRED') throw new ConflictException('Срок действия приглашения истёк');
      if (invite.status === 'OPEN') {
        await client.query('UPDATE invites SET revoked_at = now() WHERE id = $1', [id]);
        await auditExchange(client, current, 'invites', id, 'revoked', { status: 'OPEN' }, { status: 'REVOKED' }, reason);
      }
      return this.one(client, id);
    });
  }

  private async createOne(client: PoolClient, userId: string, note: string, role: ParticipantRole | null, days: number) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rows: [invite] } = await client.query<{ id: string }>(`
        INSERT INTO invites (code, note, preset_role, created_by, expires_at)
        VALUES ($1, $2, $3, $4, now() + $5::int * interval '1 day')
        ON CONFLICT (code) DO NOTHING RETURNING id
      `, [createCode(), note, role, userId, days]);
      if (invite) return this.one(client, invite.id);
    }
    throw new ServiceUnavailableException('Не удалось создать уникальный код. Попробуйте ещё раз');
  }

  private async one(client: PoolClient, id: string) {
    const { rows: [invite] } = await client.query<{ id: string; code: string }>(`
      SELECT ${inviteColumns} FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.id = $1
    `, [id]);
    return invite;
  }

  private async lockAdmin(client: PoolClient, actor: StaffSession<'ADMIN'>) {
    const { rows: [owner] } = await client.query<{ username: string }>(`
      SELECT username FROM users WHERE id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'
        AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE
    `, [actor.id]);
    if (!owner) throw new ForbiddenException('Доступ администратора ограничен');
    const session = await client.query(`
      SELECT 1 FROM auth_sessions WHERE user_id = $1 AND token_hash = $2
        AND expires_at > clock_timestamp() FOR SHARE
    `, [actor.id, actor.sessionHash]);
    if (!session.rowCount) throw new ForbiddenException('Сеанс администратора завершён. Войдите снова');
    return { id: actor.id, username: owner.username, role: 'ADMIN' as const };
  }
}
