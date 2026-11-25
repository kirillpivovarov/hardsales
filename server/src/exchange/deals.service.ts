import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { DatabaseService, type Queryable } from '../database/database.service'
import { boolean, currencies, integer, object, oneOf, pageParams, priceValue, str, uuid } from '../market/market.inputs'
import { auditExchange } from './audit'
import { ExchangeJobs } from './jobs'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'
import { lockTrustStaff } from './trust-access'
import { TrustService } from './trust.service'

const statuses = ['NEGOTIATING', 'AGREED', 'FAILED', 'EXECUTED'] as const
const reasons = ['Цена', 'Оплата', 'Сроки', 'Товар', 'Документы', 'Контрагент пропал', 'Другое'] as const
type Agreement = { amount: number; quantity: number; currency: string }
type Deal = {
  id: string; disclosure_id: string; seller_id: string; buyer_id: string
  seller_agreed: Agreement | null; buyer_agreed: Agreement | null; status: typeof statuses[number]
  amount_mismatch: boolean; seller_executed_at: Date | null; buyer_executed_at: Date | null
  admin_verified_at: Date | null; admin_rejected_at: Date | null
}
const projection = `
  d.id, d.disclosure_id AS "disclosureId", 'R-' || lpad(s.number::text, greatest(6,length(s.number::text)), '0') AS "disclosureNumber",
  d.seller_id AS "sellerId", d.buyer_id AS "buyerId", d.sell_listing_id AS "sellListingId", d.buy_listing_id AS "buyListingId",
  a.title AS "sellTitle", b.title AS "buyTitle",
  d.status, d.seller_agreed AS "sellerAgreed", d.buyer_agreed AS "buyerAgreed", d.amount_mismatch AS "amountMismatch",
  d.failed_reason AS "failedReason", d.seller_executed_at AS "sellerExecutedAt", d.buyer_executed_at AS "buyerExecutedAt",
  d.admin_verified_at AS "adminVerifiedAt", d.admin_rejected_at AS "adminRejectedAt", d.admin_note AS "adminNote",
  d.created_at AS "createdAt", d.updated_at AS "updatedAt"
`
const joins = `FROM deals d JOIN disclosures s ON s.id = d.disclosure_id
  LEFT JOIN listings a ON a.id = d.sell_listing_id LEFT JOIN listings b ON b.id = d.buy_listing_id`

@Injectable()
export class DealsService implements OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: ExchangeJobs,
    private readonly settings: PlatformSettings,
    private readonly notify: ExchangeNotifications,
    private readonly trust: TrustService,
  ) {}

  onApplicationBootstrap() {
    this.jobs.register({ name: 'deals.followups', lock: 13, run: client => this.followups(client) })
  }

  async list(userId: string, query: Record<string, unknown>) {
    await this.trust.requireEnabled()
    const { page, limit, offset } = pageParams(query)
    const [records, count] = await Promise.all([
      this.db.query(`SELECT ${projection} ${joins} WHERE $1 IN (d.seller_id, d.buyer_id)
        ORDER BY d.created_at DESC, d.id LIMIT $2 OFFSET $3`, [userId, limit, offset]),
      this.db.query<{ total: number }>('SELECT count(*)::int AS total FROM deals WHERE $1 IN (seller_id, buyer_id)', [userId]),
    ])
    return { items: records.rows, total: count.rows[0].total, page, limit }
  }

  async show(userId: string, requested: string) {
    await this.trust.requireEnabled()
    return this.read(this.db, uuid(requested), userId)
  }

  private async read(client: Queryable, id: string, userId: string | null) {
    const { rows: [deal] } = await client.query<{ disclosureId: string } & Record<string, unknown>>(`
      SELECT ${projection} ${joins} WHERE d.id = $1 AND ($2::uuid IS NULL OR $2 IN (d.seller_id,d.buyer_id))
    `, [id, userId])
    if (!deal) throw new NotFoundException('Сделка не найдена')
    const { rows: events } = await client.query(`
      SELECT id::text, actor_user_id AS "actorUserId", type, data, created_at AS "createdAt"
      FROM disclosure_events WHERE disclosure_id = $1 AND type IN ('DEAL_STATUS','DEAL_VERIFIED')
      ORDER BY id DESC LIMIT 100
    `, [deal.disclosureId])
    return { ...deal, events }
  }

  async changeStatus(userId: string, requested: string, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(requested)
    const data = object(raw)
    const status = oneOf(data.status, statuses, 'Статус сделки')
    const agreement = status === 'AGREED' ? {
      amount: priceValue(data.amount, 'Сумма'), quantity: integer(data.quantity, 'Количество', 1, 1_000_000),
      currency: oneOf(data.currency, currencies, 'Валюта'),
    } : null
    const reasonCodes: Record<string, typeof reasons[number]> = {
      PRICE: 'Цена', PAYMENT: 'Оплата', TIMING: 'Сроки', GOODS: 'Товар', DOCUMENTS: 'Документы',
      NO_RESPONSE: 'Контрагент пропал', OTHER: 'Другое',
    }
    const reason = status === 'FAILED' ? oneOf(
      typeof data.reason === 'string' && Object.hasOwn(reasonCodes, data.reason) ? reasonCodes[data.reason] : data.reason,
      reasons, 'Причина',
    ) : null

    return this.db.transaction(async client => {
      const { rows: [membership] } = await client.query<Pick<Deal, 'seller_id' | 'buyer_id'>>(`
        SELECT seller_id,buyer_id FROM deals WHERE id = $1 AND $2 IN (seller_id,buyer_id)
      `, [id, userId])
      if (!membership) throw new NotFoundException('Сделка не найдена')
      const participants = await client.query<{ id: string; active: boolean }>(`
        SELECT id, status = 'ACTIVE' AND email_verified_at IS NOT NULL AS active
        FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE
      `, [[membership.seller_id, membership.buyer_id]])
      if (!participants.rows.some(user => user.id === userId && user.active)) {
        throw new ForbiddenException('Профиль недоступен')
      }
      const { rows: [deal] } = await client.query<Deal>(`
        SELECT * FROM deals WHERE id = $1 AND $2 IN (seller_id, buyer_id) FOR UPDATE
      `, [id, userId])
      if (!deal) throw new NotFoundException('Сделка не найдена')
      if (deal.status === 'FAILED' || deal.status === 'EXECUTED') throw new ConflictException('Статус завершённой сделки не меняется')
      const seller = deal.seller_id === userId
      const partner = seller ? deal.buyer_id : deal.seller_id
      let result: Deal['status'] = deal.status
      let mismatch = deal.amount_mismatch

      if (agreement) {
        if (deal.seller_executed_at || deal.buyer_executed_at) throw new ConflictException('После подтверждения исполнения условия не меняются')
        const other = seller ? deal.buyer_agreed : deal.seller_agreed
        result = other ? 'AGREED' : 'NEGOTIATING'
        mismatch = Boolean(other && (other.amount !== agreement.amount || other.quantity !== agreement.quantity || other.currency !== agreement.currency))
        await client.query(`
          UPDATE deals SET ${seller ? 'seller_agreed' : 'buyer_agreed'} = $2::jsonb,
            status = $3, amount_mismatch = $4, updated_at = now() WHERE id = $1
        `, [id, JSON.stringify(agreement), result, mismatch])
        await this.notify.notify(client, partner, {
          kind: 'deal.agreed', title: 'Контрагент указал условия сделки',
          body: `${agreement.amount} ${agreement.currency}, ${agreement.quantity} шт. Подтвердите условия со своей стороны.`,
          payload: { dealId: id }, actions: [{ label: 'Открыть сделку', href: '/deals/' + id }],
        })
        if (mismatch && !deal.amount_mismatch) {
          const { rows: staff } = await client.query<{ id: string }>(
            "SELECT id FROM users WHERE role IN ('ADMIN','MODERATOR') AND status = 'ACTIVE' AND email_verified_at IS NOT NULL",
          )
          for (const user of staff) await this.notify.notify(client, user.id, {
            kind: 'deal.amount_mismatch', title: 'Условия сделки расходятся',
            body: 'Стороны указали разные суммы, валюты или количество. Уточните условия при проверке сделки.',
            payload: { dealId: id, disclosureId: deal.disclosure_id },
            actions: [{ label: 'К проверке', href: '/admin?section=exchange&part=verification' }],
          })
        }
      } else if (status === 'EXECUTED') {
        if (deal.status !== 'AGREED') throw new ConflictException('Сначала обе стороны должны указать условия сделки')
        if (seller ? deal.seller_executed_at : deal.buyer_executed_at) return this.read(client, id, userId)
        result = (seller ? deal.buyer_executed_at : deal.seller_executed_at) ? 'EXECUTED' : 'AGREED'
        await client.query(`
          UPDATE deals SET ${seller ? 'seller_executed_at' : 'buyer_executed_at'} = now(),
            status = $2, updated_at = now() WHERE id = $1
        `, [id, result])
      } else if (status === 'FAILED') {
        result = 'FAILED'
        await client.query("UPDATE deals SET status = 'FAILED', failed_reason = $2, updated_at = now() WHERE id = $1", [id, reason])
      }

      await this.event(client, deal.disclosure_id, userId, 'DEAL_STATUS', { status, resultingStatus: result, agreement, reason, amountMismatch: mismatch })
      return this.read(client, id, userId)
    })
  }

  async check(actor: StaffSession, requested: string, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(requested)
    const data = object(raw)
    const approve = boolean(data.approve, 'Засчитать сделку')
    const note = approve && !data.note ? null : str(data.note, 'Причина', 3, 1000)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      const { rows: [subject] } = await client.query<Deal>('SELECT seller_id,buyer_id FROM deals WHERE id = $1', [id])
      if (!subject) throw new NotFoundException('Сделка не найдена')
      const participantIds = [subject.seller_id, subject.buyer_id].sort()
      await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [participantIds])
      const { rows: [deal] } = await client.query<Deal>('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id])
      if (deal.status !== 'EXECUTED' || !deal.seller_executed_at || !deal.buyer_executed_at) {
        throw new ConflictException('Обе стороны должны подтвердить исполнение сделки')
      }
      if (deal.admin_verified_at || deal.admin_rejected_at) throw new ConflictException('Сделка уже проверена')
      if (approve && !(await client.query(`
        SELECT 1 FROM verification_documents WHERE deal_id = $1 AND kind = 'DEAL_DOC' AND status <> 'REJECTED' LIMIT 1
      `, [id])).rowCount) throw new ConflictException('Для зачёта нужен документ по сделке')

      await client.query(`
        UPDATE deals SET ${approve ? 'admin_verified_at' : 'admin_rejected_at'} = now(),
          admin_note = $2, updated_at = now() WHERE id = $1
      `, [id, note])
      if (approve) await client.query(`
        UPDATE users SET verification_level = 2
        WHERE id = ANY($1::uuid[]) AND verification_level >= 1 AND status <> 'BANNED'
      `, [participantIds])
      for (const userId of participantIds) {
        await this.trust.refresh(client, userId)
        if (approve) await this.notify.notify(client, userId, {
          kind: 'deal.verified', title: 'Сделка подтверждена',
          body: 'Модератор подтвердил исполнение сделки. Уровень проверки указан в вашем профиле.',
          payload: { dealId: id }, actions: [{ label: 'Открыть сделку', href: '/deals/' + id }],
        })
      }
      await this.event(client, deal.disclosure_id, actor.id, 'DEAL_VERIFIED', { approved: approve, note })
      await auditExchange(client, actor, 'deals', id, 'verified', undefined, { approved: approve }, note)
      return this.read(client, id, null)
    })
  }

  private async event(client: PoolClient, disclosureId: string, actor: string, type: 'DEAL_STATUS' | 'DEAL_VERIFIED', data: object) {
    await client.query(`
      INSERT INTO disclosure_events (disclosure_id,actor_user_id,type,data) VALUES ($1,$2,$3,$4)
    `, [disclosureId, actor, type, JSON.stringify(data)])
  }

  private async followups(client: PoolClient) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return { sent: 0 }
    const { rows: due } = await client.query<{
      id: string; seller_id: string; buyer_id: string; elapsed: number; number: string
    }>(`
      SELECT d.id,d.seller_id,d.buyer_id,
        extract(epoch FROM now()-s.accepted_at)::float8 / 86400 AS elapsed, s.number::text
      FROM deals d JOIN disclosures s ON s.id = d.disclosure_id
      WHERE d.status IN ('NEGOTIATING','AGREED') AND (
        (s.accepted_at <= now() - interval '3 days' AND NOT (d.followups ? '3'))
        OR (s.accepted_at <= now() - interval '7 days' AND NOT (d.followups ? '7'))
        OR (s.accepted_at <= now() - interval '14 days' AND NOT (d.followups ? '14'))
      ) ORDER BY d.created_at LIMIT 100
    `)
    if (due.length) {
      const participantIds = [...new Set(due.flatMap(deal => [deal.seller_id, deal.buyer_id]))]
      // Deal decisions and notification FK checks use the same user-before-deal order.
      await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE', [participantIds])
    }
    let sent = 0
    for (const deal of due) {
      const { rows: [current] } = await client.query<{ status: string; followups: Record<string, string> }>(`
        SELECT status,followups FROM deals WHERE id = $1 AND status IN ('NEGOTIATING','AGREED') FOR UPDATE SKIP LOCKED
      `, [deal.id])
      if (!current) continue
      for (const day of [3, 7, 14]) {
        if (deal.elapsed < day || current.followups[day]) continue
        for (const user of [deal.seller_id, deal.buyer_id]) {
          const title = current.status === 'AGREED' ? 'Исполнена ли сделка?' : 'Уточните статус сделки'
          await this.notify.notify(client, user, {
            kind: 'deal.followup', title, body: `После обмена контактами R-${deal.number.padStart(6, '0')} прошло ${day} дней. Если статус изменился, обновите его в карточке сделки.`,
            payload: { dealId: deal.id, day }, actions: [
              ...(current.status === 'AGREED' ? [{ label: 'Подтвердить исполнение', href: '/deals/' + deal.id + '?status=EXECUTED' }]
                : [{ label: 'Указать условия', href: '/deals/' + deal.id + '?status=AGREED' }]),
              { label: 'Идут переговоры', href: '/deals/' + deal.id + '?status=NEGOTIATING' },
              { label: 'Сделка не состоялась', href: '/deals/' + deal.id + '?status=FAILED' },
            ],
            dedupeKey: `deal-followup:${deal.id}:${day}`, channels: ['EMAIL'],
          })
        }
        await client.query('UPDATE deals SET followups = followups || jsonb_build_object($2::text, now()) WHERE id = $1', [deal.id, day])
        sent += 2
      }
    }
    return { sent }
  }
}
