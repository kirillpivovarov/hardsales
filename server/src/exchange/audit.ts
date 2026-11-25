import type { SessionUser } from '../auth/auth.types';
import type { Queryable } from '../database/database.service';

export async function auditExchange(client: Queryable, actor: Pick<SessionUser, 'id' | 'username' | 'role'>,
  entity: string, id: string, action: string, before: unknown = null, after: unknown = null,
  reason: string | null = null): Promise<void> {
  await client.query(`
    INSERT INTO moderation_audit (actor, actor_user_id, actor_role, entity, entity_id, action, before_data, after_data, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [actor.username, actor.id, actor.role, entity, id, action, before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after), reason]);
}
