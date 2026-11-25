import { UnauthorizedException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'

/** Recheck an authenticated staff session while the transaction owns its locks. */
export async function lockTrustStaff(client: PoolClient, actor: StaffSession) {
  const staff = await client.query(`
    SELECT 1 FROM users WHERE id = $1 AND role = $2 AND status = 'ACTIVE'
      AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE
  `, [actor.id, actor.role])
  if (!staff.rowCount) throw new UnauthorizedException('Профиль сотрудника изменился. Войдите снова.')
  const session = await client.query(`
    SELECT 1 FROM auth_sessions WHERE token_hash = $1 AND user_id = $2 AND expires_at > now() FOR SHARE
  `, [actor.sessionHash, actor.id])
  if (!session.rowCount) throw new UnauthorizedException('Войдите снова.')
}
