import { ConflictException, Injectable } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { ExchangeActions } from '../exchange/actions'
import { auditExchange } from '../exchange/audit'
import { ExchangeNotifications } from '../exchange/notifications'
import { PlatformSettings } from '../exchange/platform-settings'
import { listingPublicWhere, visibleCategories } from './market.queries'

export type ListingReviewReason = 'PRICE_OUTSIDE' | 'POSSIBLE_DUPLICATE'
export const listingReviewReasons = ['PRICE_OUTSIDE', 'POSSIBLE_DUPLICATE'] as const
const reviewLabels: Record<ListingReviewReason, string> = {
  PRICE_OUTSIDE: 'цена вне рыночного коридора', POSSIBLE_DUPLICATE: 'похожее предложение',
}
export const ownerDecisionPurposes = ['listing.owner-confirm', 'listing.owner-reject'] as const
export const ownerDecisionDuration = 7 * 24 * 60 * 60 * 1000

type ListingSummary = {
  id: string; ownerId: string; title: string; quantity: number; currency: string; price: number | null
  originCountry?: unknown; country?: unknown; destinationCountry?: unknown; kind: string; createdAt?: unknown
  status: string; createdByStaff?: unknown
}
type AuditOwner = { id: string; username: string; role: 'BUYER' | 'SELLER' }

@Injectable()
export class ListingPublication {
  constructor(private readonly settings: PlatformSettings, private readonly notifications: ExchangeNotifications,
    private readonly actions: ExchangeActions) {}

  async signals(client: PoolClient, listingId: string): Promise<ListingReviewReason[]> {
    if (!await this.settings.enabled('feature_listing_premoderation', client)) return []
    const { rows: [listing] } = await client.query<{ outside: boolean }>(`
      SELECT l.corridor_outside AS outside
      FROM listings l JOIN users u ON u.id=l.owner_id
      WHERE l.id=$1 AND u.verification_level=0
    `, [listingId])
    if (!listing) return []
    const reasons: ListingReviewReason[] = []
    if (listing.outside) reasons.push('PRICE_OUTSIDE')
    if (await this.possibleDuplicate(client, listingId)) reasons.push('POSSIBLE_DUPLICATE')
    return reasons
  }

  private async possibleDuplicate(client: PoolClient, listingId: string) {
    if (!await this.settings.enabled('feature_lot_groups', client)) return false
    const tolerance = await this.settings.get<number>('lot_price_tolerance', client)
    const { rows: [match] } = await client.query<{ found: boolean }>(`
      ${visibleCategories}
      SELECT EXISTS (
        SELECT 1 FROM listings mine JOIN fx_rates x ON x.currency=mine.currency
        JOIN listings l ON l.lot_key=mine.lot_key AND l.owner_id<>mine.owner_id
        JOIN users u ON u.id=l.owner_id JOIN fx_rates f ON f.currency=l.currency
        JOIN hardware_models model ON model.id=mine.model_id AND model.status='ACTIVE'
        WHERE mine.id=$1 AND mine.price_mode='FIXED' AND l.price_mode='FIXED'
          AND l.price IS NOT NULL AND mine.price IS NOT NULL AND l.duplicate_of IS NULL
          AND x.usd_per_unit IS NOT NULL AND f.usd_per_unit IS NOT NULL
          AND abs(mine.price*x.usd_per_unit-l.price*f.usd_per_unit)
            <= least(mine.price*x.usd_per_unit,l.price*f.usd_per_unit)*$2::numeric
          AND ${listingPublicWhere}
          AND NOT EXISTS (SELECT 1 FROM lot_group_members m WHERE m.listing_id=l.id AND m.role='PRIMARY')
          AND NOT EXISTS (SELECT 1 FROM lot_group_exclusions e
            WHERE e.listing_a=least(mine.id,l.id) AND e.listing_b=greatest(mine.id,l.id))
      ) AS found
    `, [listingId, tolerance])
    return match.found
  }

  async pendingReview(client: PoolClient, listing: { id: string; title: string }, reasons: ListingReviewReason[]) {
    await this.notifications.notifyStaff(client, {
      kind: 'listing.pending_review', title: `Объявление ждёт проверки: ${listing.title}`,
      body: reasons.map(reason => reviewLabels[reason]).join(', '), channels: ['EMAIL'],
      actions: [{ label: 'Открыть очередь', href: '/admin?section=listings&status=PENDING_REVIEW' }],
    })
  }

  async ownerNotice(client: PoolClient, listing: ListingSummary) {
    const expiresAt = new Date(Date.now() + ownerDecisionDuration)
    const reject = await this.actions.issue(client, {
      purpose: 'listing.owner-reject', subjectId: listing.id, userId: listing.ownerId, expiresAt,
    })
    const confirm = await this.actions.issue(client, {
      purpose: 'listing.owner-confirm', subjectId: listing.id, userId: listing.ownerId, expiresAt,
      payload: { rejectHref: '/a/' + reject },
    })
    const summary = this.summary(listing)
    const price = summary.price === null ? 'договорная цена' : `${summary.price} ${summary.currency} за шт.`
    const body = [`${summary.title}, ${summary.quantity} шт., ${price}`, summary.country].filter(Boolean).join(' · ')
    await this.notifications.notify(client, listing.ownerId, {
      kind: 'listing.owner_confirm', title: 'Модератор завёл объявление от вашего имени',
      body: body + '. Проверьте данные и подтвердите публикацию.', channels: ['EMAIL', 'TELEGRAM'],
      payload: { listingId: listing.id, confirmHref: '/a/' + confirm, rejectHref: '/a/' + reject },
      actions: [
        { label: 'Подтверждаю, публиковать', href: '/a/' + confirm },
        { label: 'Исправить', href: '/listings/' + listing.id + '/edit' },
        { label: 'Отказаться', href: '/a/' + reject },
      ],
    })
  }

  summary(listing: ListingSummary) {
    const location = listing.kind === 'SELL' ? listing.originCountry : listing.destinationCountry
    return { listingId: listing.id, title: listing.title, quantity: listing.quantity, price: listing.price,
      currency: listing.currency, country: typeof location === 'string' ? location : null }
  }

  async invalidateOwnerActions(client: PoolClient, id: string) {
    await client.query(`
      UPDATE action_tokens SET used_at=now() WHERE subject_id=$1 AND purpose=ANY($2::text[]) AND used_at IS NULL
    `, [id, ownerDecisionPurposes])
  }

  async ownerActor(client: PoolClient, ownerId: string) {
    return (await client.query<AuditOwner>('SELECT id,username,role FROM users WHERE id=$1', [ownerId])).rows[0]
  }

  async deleteDraft(client: PoolClient, listing: ListingSummary, actor: Pick<StaffSession, 'id' | 'username' | 'role'> | AuditOwner,
    expired = false) {
    if (listing.status !== 'PENDING_OWNER') throw new ConflictException('Объявление больше не ждёт владельца')
    if (!expired) await this.invalidateOwnerActions(client, listing.id)
    await client.query('DELETE FROM listing_price_history WHERE listing_id=$1', [listing.id])
    // Drafts cannot be used for deals, but their owner can have uploaded evidence beforehand.
    await client.query('UPDATE listings SET proof_document_id=NULL WHERE id=$1', [listing.id])
    await client.query('DELETE FROM verification_documents WHERE listing_id=$1', [listing.id])
    await client.query('DELETE FROM listings WHERE id=$1', [listing.id])
    await auditExchange(client, actor, 'listings', listing.id, expired ? 'owner-confirm-expired' : 'owner-rejected',
      this.summary(listing))
  }

  async expiryCandidates(client: PoolClient) {
    return (await client.query<{ id: string; ownerId: string; createdByStaff: string }>(`
      SELECT id,owner_id AS "ownerId",created_by_staff AS "createdByStaff" FROM listings
      WHERE status='PENDING_OWNER' AND created_at <= now()-interval '7 days'
      ORDER BY owner_id,id LIMIT 100
    `)).rows
  }

  async staffActor(client: PoolClient, staffId: string) {
    return (await client.query<Pick<StaffSession,'id' | 'username' | 'role'>>(`
      SELECT id,username,role FROM users WHERE id=$1 AND role IN ('ADMIN','MODERATOR')
    `, [staffId])).rows[0]
  }

  async expiredNotice(client: PoolClient, staffId: string, listing: ListingSummary) {
    await this.notifications.notify(client, staffId, {
      kind: 'listing.owner_expired', title: 'Владелец не подтвердил объявление',
      body: `Черновик «${listing.title}» удалён через 7 дней.`, channels: ['EMAIL'],
    })
  }
}
