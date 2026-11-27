import type { Queryable } from '../database/database.service'
import type { accountStatuses } from './market.inputs'

export async function persistAccountStatus(client: Queryable, userId: string, status: typeof accountStatuses[number]) {
  const { rows: [user] } = await client.query<{ credential_version: number }>(`
    UPDATE users SET status=$2, updated_at=now(), credential_version=credential_version+1
    WHERE id=$1 RETURNING credential_version
  `, [userId, status])
  await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId])
  return user.credential_version
}
