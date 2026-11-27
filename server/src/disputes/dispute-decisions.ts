import { BadRequestException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { auditExchange } from '../exchange/audit'
import { persistAccountStatus } from '../market/account-status'
import type { accountStatuses } from '../market/market.inputs'

export const penalties = ['NONE', 'MISREPRESENTATION', 'HIDDEN_MARKUP', 'NO_CORRESPONDENCE', 'LOST', 'BYPASS', 'FORGERY'] as const
export type Penalty = typeof penalties[number]
export const penaltyDescriptions: Record<Penalty, string> = {
  NONE: 'спор отклонён',
  MISREPRESENTATION: 'штраф 10 баллов за расхождение с объявлением',
  HIDDEN_MARKUP: 'метка об открытом вознаграждении снята на 90 дней',
  NO_CORRESPONDENCE: 'спор решён в пользу другой стороны',
  LOST: 'зафиксирован проигранный спор',
  BYPASS: 'профиль заблокирован за обход площадки',
  FORGERY: 'профиль заблокирован за подделку',
}
export type Status = typeof accountStatuses[number]
type DisputeReference = { id: string; number: string; disclosure_id: string }
type AccountEffect = { before: Status; version: number }
type ListingEffect = { id: string; before: string; version: string }
type FeeEffect = { before: string | null; version: string }
type Effects = { account?: AccountEffect; listing?: ListingEffect; agentFee?: FeeEffect }
export type PriorDecision = { loser_id: string | null; decided_by: string; listing_id: string | null; penalty: Penalty; effects: Effects }

export async function applyDisputeEffects(client: PoolClient, actor: StaffSession, dispute: DisputeReference,
  loserId: string, penalty: Penalty, listingId: string | null): Promise<Effects> {
  const reason = 'Решение по спору №' + dispute.number
  switch (penalty) {
    case 'MISREPRESENTATION': {
      if (!listingId) throw new BadRequestException('Выберите объявление проигравшей стороны')
      const { rows: [listing] } = await client.query<{ status: string }>(
        'SELECT status FROM listings WHERE id=$1 AND owner_id=$2 FOR UPDATE', [listingId, loserId],
      )
      if (!listing) throw new BadRequestException('Выберите объявление проигравшей стороны')
      await client.query(`
        INSERT INTO user_penalties(user_id,kind,points,reason,created_by,dispute_id)
        VALUES($1,'DISPUTE',10,$2,$3,$4)
      `, [loserId, reason, actor.id, dispute.id])
      if (!['ACTIVE', 'HIDDEN'].includes(listing.status)) return {}
      const freezeReason = 'Скрыто по решению спора ' + dispute.number
      const { rows: [frozen] } = await client.query<{ version: string }>(`
        UPDATE listings SET status='FROZEN', updated_at=clock_timestamp()
        WHERE id=$1 RETURNING updated_at::text AS version
      `, [listingId])
      await auditExchange(client, actor, 'listings', listingId, 'status-changed', { status: listing.status },
        { status: 'FROZEN', disputeId: dispute.id }, freezeReason)
      return { listing: { id: listingId, before: listing.status, version: frozen.version } }
    }
    case 'BYPASS':
    case 'FORGERY': {
      const { rows: [user] } = await client.query<{ status: Status }>('SELECT status FROM users WHERE id=$1', [loserId])
      if (user.status === 'BANNED') return {}
      const version = await persistAccountStatus(client, loserId, 'BANNED')
      await auditExchange(client, actor, 'users', loserId, 'status-changed', { status: user.status },
        { status: 'BANNED', disputeId: dispute.id }, reason)
      return { account: { before: user.status, version } }
    }
    case 'HIDDEN_MARKUP': {
      const { rows: [user] } = await client.query<{ before: string | null; version: string }>(`
        WITH previous AS (SELECT agent_fee_banned_until AS before FROM users WHERE id=$1)
        UPDATE users SET agent_fee_banned_until=greatest(now()+interval '90 days',previous.before)
        FROM previous WHERE id=$1 RETURNING previous.before::text AS before,agent_fee_banned_until::text AS version
      `, [loserId])
      return { agentFee: user }
    }
    default: return {}
  }
}

export async function reverseDisputeEffects(client: PoolClient, actor: StaffSession, dispute: DisputeReference, prior: PriorDecision) {
  if (!prior.loser_id) return
  const { listing, account, agentFee } = prior.effects
  const reason = 'Пересмотр спора №' + dispute.number
  const { rows: [penalty] } = await client.query(`
    DELETE FROM user_penalties WHERE dispute_id=$1 RETURNING id::text,user_id,points,reason,created_at
  `, [dispute.id])
  if (penalty) await auditExchange(client, actor, 'disputes', dispute.id, 'penalty-reversed', penalty, null, reason)
  if (listing) {
    const outcome = await client.query(`
      UPDATE listings SET status=$2,updated_at=now() WHERE id=$1 AND status='FROZEN'
        AND updated_at=$3::timestamptz AND duplicate_of IS NULL AND NOT spot_check_hold
        AND NOT EXISTS (
          SELECT 1 FROM disputes p JOIN dispute_decisions d ON d.dispute_id=p.id
          WHERE p.id<>$4 AND d.listing_id=$1 AND d.penalty='MISREPRESENTATION'
          AND NOT EXISTS (SELECT 1 FROM dispute_decisions newer WHERE newer.dispute_id=p.id AND newer.round>d.round)
        )
    `, [listing.id, listing.before, listing.version, dispute.id])
    if (outcome.rowCount) await auditExchange(client, actor, 'listings', listing.id, 'status-changed',
      { status: 'FROZEN', disputeId: dispute.id }, { status: listing.before }, reason)
  }
  if (account) {
    const { rowCount } = await client.query(`
      SELECT 1 FROM users WHERE id=$1 AND credential_version=$2 AND status='BANNED' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM disputes p JOIN dispute_decisions d ON d.dispute_id=p.id
          WHERE p.id<>$3 AND d.loser_id=$1 AND d.penalty IN ('BYPASS','FORGERY')
          AND NOT EXISTS (SELECT 1 FROM dispute_decisions newer WHERE newer.dispute_id=p.id AND newer.round>d.round)
        )
        AND NOT EXISTS (
          SELECT 1 FROM moderation_audit WHERE entity='users' AND entity_id=$1::text
            AND action='status-unchanged' AND after_data->>'status'='BANNED'
            AND created_at > (SELECT decided_at FROM dispute_decisions WHERE dispute_id=$3 AND round=1)
        )
    `, [prior.loser_id, account.version, dispute.id])
    if (rowCount) {
      await persistAccountStatus(client, prior.loser_id, account.before)
      await auditExchange(client, actor, 'users', prior.loser_id, 'status-changed',
        { status: 'BANNED', disputeId: dispute.id }, { status: account.before }, reason)
    }
  }
  if (agentFee) {
    await client.query(`
      UPDATE users SET agent_fee_banned_until=$2::timestamptz
      WHERE id=$1 AND agent_fee_banned_until=$3::timestamptz AND deleted_at IS NULL
    `, [prior.loser_id, agentFee.before, agentFee.version])
  }
}
