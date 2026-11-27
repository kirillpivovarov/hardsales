import { ConflictException, ForbiddenException, GoneException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashToken } from '../auth/auth.crypto';
import { DatabaseService, type Queryable } from '../database/database.service';
import { policyRequired, policyVersion } from '../privacy/policy';

export interface ExchangeAction {
  purpose: string;
  userId: string | null;
  subjectId: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
}
type ActionHandler = {
  describe: (client: PoolClient, token: ExchangeAction) => Promise<object>;
  execute: (client: PoolClient, token: ExchangeAction, input: unknown) => Promise<object>;
  lockSubjects?: (client: PoolClient, token: ExchangeAction) => Promise<void>;
};

@Injectable()
export class ExchangeActions {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(private readonly db: DatabaseService) {}

  register(purpose: string, handler: ActionHandler): void {
    if (this.handlers.has(purpose)) throw new Error('Duplicate action handler ' + purpose);
    this.handlers.set(purpose, handler);
  }

  async issue(client: Queryable, action: Omit<ExchangeAction, 'userId' | 'payload'> & {
    userId?: string | null; payload?: Record<string, unknown>;
  }): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO action_tokens (token_hash,purpose,user_id,subject_id,payload,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [hashToken(token), action.purpose, action.userId ?? null, action.subjectId, JSON.stringify(action.payload ?? {}), action.expiresAt]);
    return token;
  }

  async open(token: string, ip: string, input?: { body: unknown }): Promise<object> {
    await this.limit(this.db, 'action-ip:' + hashToken(ip), 15, 60);
    return this.db.transaction(client => this.use(client, token, input));
  }

  async limitTelegram(client: Queryable, actorUserId: string): Promise<void> {
    await this.limit(client, 'telegram-callback:' + hashToken(actorUserId), 1, 30);
  }

  async runForUser(token: string, body: unknown, actorUserId: string, client?: PoolClient, telegramChatId?: string,
    beforeExecute?: () => Promise<unknown>): Promise<object> {
    if (client) return this.use(client, token, { body }, actorUserId, telegramChatId, beforeExecute);
    await this.limitTelegram(this.db, actorUserId);
    return this.db.transaction(transaction => this.use(transaction, token, { body }, actorUserId, telegramChatId, beforeExecute));
  }

  inspectForUser(client: PoolClient, token: string, actorUserId: string): Promise<object> {
    return this.use(client, token, undefined, actorUserId);
  }

  private async use(client: PoolClient, token: string, input?: { body: unknown }, actorUserId?: string, telegramChatId?: string,
    beforeExecute?: () => Promise<unknown>): Promise<object> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Ссылка не найдена');
    const hash = hashToken(token);
    const load = async (lock = false) => (await client.query<ExchangeAction & { used: boolean; expired: boolean }>(`
      SELECT purpose,user_id AS "userId", subject_id AS "subjectId",payload,
        expires_at AS "expiresAt", used_at IS NOT NULL AS used, expires_at <= now() AS expired
      FROM action_tokens WHERE token_hash=$1 ${lock ? 'FOR UPDATE' : ''}
    `, [hash])).rows[0];
    let action = await load();
    const handler = action && this.handlers.get(action.purpose);
    if (!handler) throw new NotFoundException('Ссылка не найдена');
    if (actorUserId !== undefined && action.userId !== actorUserId) throw new ForbiddenException('Эта кнопка не для вас');
    if (action.used) throw new ConflictException('Ссылка уже использована');
    if (action.expired) throw new GoneException('Срок ссылки истёк');
    if (input && handler.lockSubjects) await handler.lockSubjects(client, action);
    if (action.userId) {
      const { rows: [active] } = await client.query<{ role: string; pd_consent_version: string | null; telegram_chat_id: string | null }>(
        "SELECT role,pd_consent_version,telegram_chat_id FROM users WHERE id=$1 AND status='ACTIVE'" + (input ? ' FOR UPDATE' : ''), [action.userId],
      );
      if (!active) throw new ForbiddenException('Профиль недоступен');
      if (telegramChatId !== undefined && active.telegram_chat_id !== telegramChatId) throw new ForbiddenException('Telegram отвязан от профиля');
      if (input && (active.role === 'BUYER' || active.role === 'SELLER') && active.pd_consent_version !== await policyVersion(client)) {
        throw policyRequired();
      }
    }
    if (!input) return { ...await handler.describe(client, action), purpose: action.purpose, expiresAt: action.expiresAt, used: false };
    // Erasure holds the user lock before deleting action tokens. Recheck the token with the same lock order.
    action = await load(true);
    if (!action) throw new NotFoundException('Ссылка не найдена');
    if (action.used) throw new ConflictException('Ссылка уже использована');
    if (action.expired) throw new GoneException('Срок ссылки истёк');
    if (beforeExecute) await beforeExecute();
    const result = await handler.execute(client, action, input.body);
    await client.query('UPDATE action_tokens SET used_at=now() WHERE token_hash=$1', [hash]);
    return result;
  }

  private async limit(client: Queryable, bucket: string, minutes: number, max: number): Promise<void> {
    const { rows: [entry] } = await client.query<{ count: number }>(`
      INSERT INTO auth_rate_limits(bucket,count,expires_at) VALUES ($1,1,now()+$2::int*interval '1 minute')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE least(auth_rate_limits.count,$3::int)+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING count
    `, [bucket, minutes, max + 1]);
    if (entry.count > max) throw new HttpException('Слишком много запросов, повторите позже.', 429);
  }
}
