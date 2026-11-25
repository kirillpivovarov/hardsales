import { ConflictException, ForbiddenException, GoneException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashToken } from '../auth/auth.crypto';
import { DatabaseService, type Queryable } from '../database/database.service';

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
    await this.limit(ip);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Ссылка не найдена');
    return this.db.transaction(async client => {
      const hash = hashToken(token);
      const { rows: [action] } = await client.query<ExchangeAction & { used: boolean; expired: boolean }>(`
        SELECT purpose,user_id AS "userId", subject_id AS "subjectId",payload,
          expires_at AS "expiresAt", used_at IS NOT NULL AS used, expires_at <= now() AS expired
        FROM action_tokens WHERE token_hash=$1 ${input ? 'FOR UPDATE' : ''}
      `, [hash]);
      const handler = action && this.handlers.get(action.purpose);
      if (!handler) throw new NotFoundException('Ссылка не найдена');
      if (action.used) throw new ConflictException('Ссылка уже использована');
      if (action.expired) throw new GoneException('Срок ссылки истёк');
      if (action.userId) {
        const active = await client.query("SELECT id FROM users WHERE id=$1 AND status='ACTIVE'", [action.userId]);
        if (!active.rows[0]) throw new ForbiddenException('Профиль недоступен');
      }
      if (!input) return { ...await handler.describe(client, action), purpose: action.purpose, expiresAt: action.expiresAt, used: false };
      const result = await handler.execute(client, action, input.body);
      await client.query('UPDATE action_tokens SET used_at=now() WHERE token_hash=$1', [hash]);
      return result;
    });
  }

  private async limit(ip: string): Promise<void> {
    const { rows: [entry] } = await this.db.query<{ count: number }>(`
      INSERT INTO auth_rate_limits(bucket,count,expires_at) VALUES ($1,1,now()+interval '15 minutes')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE least(auth_rate_limits.count,61)+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING count
    `, ['action-ip:' + hashToken(ip)]);
    if (entry.count > 60) throw new HttpException('Слишком много запросов, повторите позже.', 429);
  }
}
