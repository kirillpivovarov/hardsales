import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { publicListingTitle, publicNickname } from '../contact-guard/public-text'
import { detectContacts } from '../contact-guard/detect'
import { DatabaseService, type Queryable } from '../database/database.service'
import { boolean, currencies, integer, object, oneOf, pageParams, priceValue, str, uuid } from '../market/market.inputs'
import { ExchangeActions } from './actions'
import { auditExchange } from './audit'
import { ExchangeJobs } from './jobs'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'
import { lockTrustStaff } from './trust-access'
import { TrustService } from './trust.service'
import { dealRatingEligibility } from './trust-score'

const statuses = ['NEGOTIATING', 'AGREED', 'FAILED', 'EXECUTED'] as const
export const dealFailureReasons = ['Цена', 'Оплата', 'Сроки', 'Товар', 'Документы', 'Контрагент пропал', 'Другое'] as const
type Agreement = { amount: number; quantity: number; currency: string }
type Deal = {
  id: string; disclosure_id: string; seller_id: string; buyer_id: string
  chat_id: string | null
  seller_agreed: Agreement | null; buyer_agreed: Agreement | null; status: typeof statuses[number]
  amount_mismatch: boolean; seller_executed_at: Date | null; buyer_executed_at: Date | null
  admin_verified_at: Date | null; admin_rejected_at: Date | null
}
type DealOrigin = 'PAIR_CHAT' | 'MANUAL'
type DealProjection = { id: string; chatId: string | null; origin: string; disclosureId: string; partnerId: string | null;
  partnerName: string | null; sellTitle: string | null; buyTitle: string | null; sellerId: string; buyerId: string;
  adminVerifiedAt: Date | null } & Record<string, unknown>
const projection = `
  d.id, d.disclosure_id AS "disclosureId", 'R-' || lpad(s.number::text, greatest(6,length(s.number::text)), '0') AS "disclosureNumber",
  d.seller_id AS "sellerId", d.buyer_id AS "buyerId", d.sell_listing_id AS "sellListingId", d.buy_listing_id AS "buyListingId",
  a.title AS "sellTitle", b.title AS "buyTitle",
  d.chat_id AS "chatId", d.match_id AS "matchId", d.origin,
  d.status, d.seller_agreed AS "sellerAgreed", d.buyer_agreed AS "buyerAgreed", d.amount_mismatch AS "amountMismatch",
  d.failed_reason AS "failedReason", d.seller_executed_at AS "sellerExecutedAt", d.buyer_executed_at AS "buyerExecutedAt",
  d.admin_verified_at AS "adminVerifiedAt", d.admin_rejected_at AS "adminRejectedAt", d.admin_note AS "adminNote",
  d.created_at AS "createdAt", d.updated_at AS "updatedAt", d.agreed_at AS "agreedAt"
`
const joins = `FROM deals d JOIN disclosures s ON s.id = d.disclosure_id
  LEFT JOIN listings a ON a.id = d.sell_listing_id LEFT JOIN listings b ON b.id = d.buy_listing_id`
const counterparty = `CASE WHEN d.seller_id=$1 THEN d.buyer_id WHEN d.buyer_id=$1 THEN d.seller_id END`
const chatPairFirst = `d.user_a_id=least(c.owner_id,c.visitor_id) AND d.user_b_id=greatest(c.owner_id,c.visitor_id)
  AND d.kind='FIRST' AND d.chat_id<>c.id`
const bilateralChat = `
  EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id AND m.sender_id=c.owner_id AND NOT m.hidden_for_peer)
  AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id AND m.sender_id=c.visitor_id AND NOT m.hidden_for_peer)`

@Injectable()
export class DealsService implements OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: ExchangeJobs,
    private readonly settings: PlatformSettings,
    private readonly notify: ExchangeNotifications,
    private readonly trust: TrustService,
    private readonly actions: ExchangeActions,
  ) {}

  onApplicationBootstrap() {
    this.actions.register('deal.status', {
      describe: async () => ({ title: 'Уточните статус сделки', fields: { reasons: dealFailureReasons } }),
      lockSubjects: async (client, token) => {
        await client.query(`SELECT u.id FROM users u JOIN deals d ON u.id IN (d.seller_id,d.buyer_id)
          WHERE d.id=$1 AND $2 IN (d.seller_id,d.buyer_id) ORDER BY u.id FOR UPDATE OF u`, [token.subjectId, token.userId])
      },
      execute: (client, token, raw) => this.changeStatus(token.userId!, token.subjectId, raw, client),
    })
    this.jobs.register({ name: 'deals.followups', lock: 13, run: client => this.followups(client) })
    this.jobs.register({ name: 'deals.pair-open', lock: 13, run: client => this.openExistingPairChats(client) })
    this.jobs.register({ name: 'deals.cleanup', lock: 13, slot: clock => clock.day, run: client => this.cleanup(client) })
  }

  async list(userId: string, query: Record<string, unknown>) {
    await this.trust.requireEnabled()
    const { page, limit, offset } = pageParams(query)
    const pairUserId = query.pairUserId === undefined ? null : uuid(query.pairUserId, 'Контрагент')
    const where = `$1 IN (d.seller_id, d.buyer_id) AND ($2::uuid IS NULL OR $2 = (${counterparty}))`
    const [records, count] = await Promise.all([
      this.db.query<DealProjection>(`SELECT ${projection}, peer.id AS "partnerId", peer.display_name AS "partnerName"
        ${joins} JOIN users peer ON peer.id=(${counterparty}) WHERE ${where}
        ORDER BY d.created_at DESC, d.id LIMIT $3 OFFSET $4`, [userId, pairUserId, limit, offset]),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM deals d WHERE ${where}`, [userId, pairUserId]),
    ])
    const rows = await this.withRatingDates(this.db, userId, records.rows)
    return { items: await this.maskPeerText(this.db, userId, rows), total: count.rows[0].total, page, limit }
  }

  async show(userId: string, requested: string) {
    await this.trust.requireEnabled()
    return this.read(this.db, uuid(requested), userId)
  }

  private async read(client: Queryable, id: string, userId: string | null) {
    const { rows: [deal] } = await client.query<DealProjection>(`
      SELECT ${projection}, peer.id AS "partnerId", peer.display_name AS "partnerName"
      ${joins} LEFT JOIN users peer ON peer.id=(${counterparty})
      WHERE d.id = $2 AND ($1::uuid IS NULL OR $1 IN (d.seller_id,d.buyer_id))
    `, [userId, id])
    if (!deal) throw new NotFoundException('Сделка не найдена')
    const { rows: events } = await client.query(`
      SELECT id::text, actor_user_id AS "actorUserId", type, data, created_at AS "createdAt"
      FROM disclosure_events WHERE disclosure_id = $1 AND type IN ('DEAL_STATUS','DEAL_VERIFIED')
        AND (data->>'dealId'=$2::text OR (NOT (data ? 'dealId') AND $3='FIRST_DISCLOSURE'))
      ORDER BY id DESC LIMIT 100
    `, [deal.disclosureId, id, deal.origin])
    const [rated] = userId ? await this.maskPeerText(client, userId, await this.withRatingDates(client, userId, [deal])) : [deal]
    return { ...rated, events }
  }

  private async maskPeerText<T extends DealProjection>(client: Queryable, userId: string, deals: T[]) {
    if (!deals.length || !await this.settings.enabled('feature_disclosure_journal', client)) return deals
    return deals.map(deal => ({
      ...deal,
      partnerName: deal.partnerName && publicNickname(deal.partnerName),
      sellTitle: deal.sellerId === userId ? deal.sellTitle : deal.sellTitle && publicListingTitle(deal.sellTitle),
      buyTitle: deal.buyerId === userId ? deal.buyTitle : deal.buyTitle && publicListingTitle(deal.buyTitle),
    }))
  }

  private async withRatingDates(client: Queryable, userId: string, deals: DealProjection[]) {
    const peers = [...new Set(deals.filter(deal => deal.adminVerifiedAt && deal.partnerId).map(deal => deal.partnerId))]
    if (!peers.length) return deals
    const { rows } = await client.query<{ id: string; counterparty: string; verified_at: Date }>(`
      SELECT d.id,(${counterparty}) AS counterparty,d.admin_verified_at AS verified_at
      FROM deals d JOIN users self ON self.id=$1 JOIN users peer ON peer.id=(${counterparty})
      WHERE peer.id=ANY($2::uuid[]) AND d.status='EXECUTED' AND d.admin_verified_at IS NOT NULL
        AND d.seller_executed_at IS NOT NULL AND d.buyer_executed_at IS NOT NULL
        AND (self.link_group IS NULL OR peer.link_group IS DISTINCT FROM self.link_group)
      ORDER BY d.admin_verified_at,d.id
    `, [userId, peers])
    const dates = new Map(dealRatingEligibility(rows).map(({ deal, nextEligibleAt }) => [deal.id, nextEligibleAt]))
    return deals.map(deal => ({ ...deal, ratingNextEligibleAt: dates.get(deal.id) ?? null }))
  }

  async chatStatus(client: Queryable, chatId: string) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return undefined
    const { rows: [row] } = await client.query<{ id: string | null; status: string | null; amountMismatch: boolean; canStart: boolean }>(`
      SELECT t.id,t.status,t.amount_mismatch AS "amountMismatch",
        (t.id IS NULL AND EXISTS(SELECT 1 FROM disclosures d WHERE ${chatPairFirst})) AS "canStart"
      FROM chats c LEFT JOIN deals t ON t.chat_id=c.id WHERE c.id=$1
    `, [chatId])
    return row.id ? { id: row.id, status: row.status, amountMismatch: row.amountMismatch, canStart: false } : { canStart: row.canStart }
  }

  async startFromChat(client: PoolClient, chatId: string, userId: string, origin: DealOrigin, matchOpened = false) {
    if (!await this.settings.enabled('feature_trust_rating', client)) {
      if (origin === 'MANUAL') await this.trust.requireEnabled(client)
      return
    }
    const result = await this.insertPairDeal(client, chatId, origin, userId, origin === 'PAIR_CHAT' && !matchOpened)
    if (!result) {
      if (origin === 'MANUAL') {
        const current = await this.chatStatus(client, chatId)
        throw new ConflictException(current && 'id' in current ? 'Сделка по этому объявлению уже есть' : 'Сначала откройте контакты')
      }
      return
    }
    const other = result.seller_id === userId ? result.buyer_id : result.seller_id
    await this.notify.notify(client, other, {
      kind: 'deal.pair_started', title: 'Начата сделка по объявлению',
      body: `Объявление «${publicListingTitle(result.title)}». Отмечайте статус в чате.`,
      payload: { dealId: result.id, chatId }, actions: [{ label: 'Открыть чат', href: '/chats/' + chatId }],
      channels: [], dedupeKey: 'deal.pair_started:' + result.id,
    })
    if (origin === 'MANUAL') return this.read(client, result.id, userId)
  }

  private async insertPairDeal(client: PoolClient, chatId: string, origin: DealOrigin, actor: string | null, requireBilateral: boolean) {
    const { rows: [deal] } = await client.query<{ id: string; disclosure_id: string; seller_id: string; buyer_id: string; title: string }>(`
      WITH source AS (
        SELECT c.id,c.match_id,l.title,
          CASE WHEN l.kind='SELL' THEN c.owner_id ELSE c.visitor_id END AS seller_id,
          CASE WHEN l.kind='BUY' THEN c.owner_id ELSE c.visitor_id END AS buyer_id,
          CASE WHEN l.kind='SELL' THEN l.id ELSE m.sell_listing_id END AS sell_listing_id,
          CASE WHEN l.kind='BUY' THEN l.id ELSE m.buy_listing_id END AS buy_listing_id,
          first.id AS disclosure_id
        FROM chats c JOIN listings l ON l.id=c.listing_id LEFT JOIN listing_matches m ON m.id=c.match_id
        JOIN LATERAL (SELECT d.id FROM disclosures d WHERE ${chatPairFirst}
          ORDER BY d.accepted_at,d.id LIMIT 1) first ON true
        WHERE c.id=$1 AND ($2::uuid IS NULL OR $2 IN (c.owner_id,c.visitor_id))
          AND NOT EXISTS(SELECT 1 FROM deals existing WHERE existing.chat_id=c.id)
          AND (NOT $3 OR (${bilateralChat}))
      ), inserted AS (
        INSERT INTO deals(disclosure_id,chat_id,match_id,seller_id,buyer_id,sell_listing_id,buy_listing_id,origin)
        SELECT disclosure_id,id,match_id,seller_id,buyer_id,sell_listing_id,buy_listing_id,$4 FROM source
        ON CONFLICT (chat_id) WHERE chat_id IS NOT NULL DO NOTHING
        RETURNING id,disclosure_id,seller_id,buyer_id
      )
      SELECT inserted.*,source.title FROM inserted CROSS JOIN source
    `, [chatId, actor, requireBilateral, origin])
    if (!deal) return
    await this.event(client, deal.disclosure_id, actor, 'DEAL_STATUS', {
      dealId: deal.id, chatId, action: 'STARTED', origin, title: publicListingTitle(deal.title),
    })
    return deal
  }

  private async openExistingPairChats(client: PoolClient) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return { created: 0 }
    const { rows } = await client.query<{ id: string; owner_id: string; visitor_id: string }>(`
      SELECT c.id,c.owner_id,c.visitor_id FROM chats c
      WHERE EXISTS(SELECT 1 FROM disclosures d WHERE ${chatPairFirst})
        AND NOT EXISTS(SELECT 1 FROM deals t WHERE t.chat_id=c.id)
        AND (${bilateralChat})
      ORDER BY c.created_at,c.id LIMIT 100
    `)
    if (rows.length) {
      const parties = [...new Set(rows.flatMap(row => [row.owner_id, row.visitor_id]))]
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE', [parties])
    }
    let created = 0
    for (const chat of rows) {
      if (await this.insertPairDeal(client, chat.id, 'PAIR_CHAT', null, true)) created++
    }
    return { created }
  }

  private async cleanup(client: PoolClient) {
    const { rowCount } = await client.query(`
      DELETE FROM deals d
      WHERE d.origin='MANUAL' AND d.status='NEGOTIATING' AND d.created_at<now()-interval '30 days'
        AND d.seller_agreed IS NULL AND d.buyer_agreed IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id=d.chat_id)
        AND NOT EXISTS (SELECT 1 FROM verification_documents f WHERE f.deal_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM disputes s WHERE s.deal_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM disclosure_events e WHERE e.disclosure_id=d.disclosure_id
          AND e.type IN ('DEAL_STATUS','DEAL_VERIFIED') AND e.data->>'dealId'=d.id::text
          AND e.data->>'action' IS DISTINCT FROM 'STARTED')
    `)
    return { deleted: rowCount }
  }

  async changeStatus(userId: string, requested: string, raw: unknown, transaction?: PoolClient) {
    await this.trust.requireEnabled(transaction)
    const id = uuid(requested)
    const change = async (client: PoolClient) => {
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
      const data = object(raw)
      const status = oneOf(data.status, statuses, 'Статус сделки')
      const agreement = status === 'AGREED' ? {
        amount: priceValue(data.amount, 'Сумма'), quantity: integer(data.quantity, 'Количество', 1, 1_000_000),
        currency: oneOf(data.currency, currencies, 'Валюта'),
      } : null
      const reasonCodes: Record<string, typeof dealFailureReasons[number]> = {
        PRICE: 'Цена', PAYMENT: 'Оплата', TIMING: 'Сроки', GOODS: 'Товар', DOCUMENTS: 'Документы',
        NO_RESPONSE: 'Контрагент пропал', OTHER: 'Другое',
      }
      const reason = status === 'FAILED' ? oneOf(
        typeof data.reason === 'string' && Object.hasOwn(reasonCodes, data.reason) ? reasonCodes[data.reason] : data.reason,
        dealFailureReasons, 'Причина',
      ) : null
      const seller = deal.seller_id === userId
      const partner = seller ? deal.buyer_id : deal.seller_id
      const parties = [deal.buyer_id, deal.seller_id].sort()
      const action = { label: 'Открыть сделку', href: '/deals/' + id }
      let result: Deal['status'] = deal.status
      let mismatch = deal.amount_mismatch

      if (agreement) {
        if (deal.seller_executed_at || deal.buyer_executed_at) throw new ConflictException('После подтверждения исполнения условия не меняются')
        const other = seller ? deal.buyer_agreed : deal.seller_agreed
        const previous = seller ? deal.seller_agreed : deal.buyer_agreed
        if (previous?.amount === agreement.amount && previous.quantity === agreement.quantity && previous.currency === agreement.currency) {
          return this.read(client, id, userId)
        }
        result = other ? 'AGREED' : 'NEGOTIATING'
        mismatch = Boolean(other && (other.amount !== agreement.amount || other.quantity !== agreement.quantity || other.currency !== agreement.currency))
        await client.query(`
          UPDATE deals SET ${seller ? 'seller_agreed' : 'buyer_agreed'} = $2::jsonb,
            status = $3, amount_mismatch = $4, updated_at = now(),
            agreed_at = CASE WHEN $3 = 'AGREED' THEN COALESCE(agreed_at, now()) ELSE agreed_at END WHERE id = $1
        `, [id, JSON.stringify(agreement), result, mismatch])
        if (other && !mismatch) {
          for (const recipient of parties) await this.notify.notify(client, recipient, {
            kind: 'deal.agreed_both', title: 'Стороны согласовали условия',
            body: 'Сделка зафиксирована как «Договорились». После поставки подтвердите исполнение.',
            payload: { dealId: id }, actions: [action], channels: ['EMAIL'],
          })
        } else {
          await this.notify.notify(client, partner, {
            kind: 'deal.agreed', title: 'Контрагент указал условия сделки',
            body: `${agreement.amount} ${agreement.currency}, ${agreement.quantity} шт. `
              + (mismatch ? 'Указанные сторонами условия расходятся. Уточните их в чате.' : 'Подтвердите условия со своей стороны.'),
            payload: { dealId: id }, actions: [action], channels: ['EMAIL'],
          })
        }
        if (mismatch && !deal.amount_mismatch) {
          await this.notify.notifyStaff(client, {
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
        if (result === 'EXECUTED') {
          for (const recipient of parties) await this.notify.notify(client, recipient, {
            kind: 'deal.executed', title: 'Сделка исполнена',
            body: 'Обе стороны подтвердили исполнение. Модератор проверит документ сделки.',
            payload: { dealId: id }, actions: [action], channels: ['EMAIL'], dedupeKey: 'deal.executed:' + id,
          })
          const { rows: [journal] } = await client.query<{ number: string }>('SELECT number FROM disclosures WHERE id=$1', [deal.disclosure_id])
          await this.notify.notifyStaff(client, {
            kind: 'deal.executed', title: 'Сделка исполнена обеими сторонами',
            body: `Сделка по раскрытию R-${String(journal.number).padStart(6, '0')} исполнена. Проверьте документ сделки.`,
            payload: { dealId: id }, dedupeKey: 'deal.executed:' + id,
            actions: [{ label: 'К проверке', href: '/admin?section=exchange&part=verification' }],
          })
        } else {
          await this.notify.notify(client, partner, {
            kind: 'deal.executed_one', title: 'Контрагент подтвердил исполнение',
            body: 'Подтвердите исполнение со своей стороны.', payload: { dealId: id }, actions: [action], channels: ['EMAIL'],
          })
        }
      } else if (status === 'FAILED') {
        result = 'FAILED'
        await client.query("UPDATE deals SET status = 'FAILED', failed_reason = $2, updated_at = now() WHERE id = $1", [id, reason])
        await this.notify.notify(client, partner, {
          kind: 'deal.failed', title: 'Контрагент отметил, что сделка сорвалась',
          body: 'Причина: ' + reason, payload: { dealId: id }, actions: [action], channels: ['EMAIL'],
          dedupeKey: 'deal.failed:' + id,
        })
      }

      await this.event(client, deal.disclosure_id, userId, 'DEAL_STATUS',
        { dealId: id, chatId: deal.chat_id, status, resultingStatus: result, agreement, reason, amountMismatch: mismatch })
      return this.read(client, id, userId)
    }
    return transaction ? change(transaction) : this.db.transaction(change)
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
        UPDATE users SET verification_level = 2, verification_source='DEAL'
        WHERE id = ANY($1::uuid[]) AND verification_level >= 1 AND status <> 'BANNED'
      `, [participantIds])
      for (const userId of participantIds) {
        await this.trust.refresh(client, userId)
        const safeNote = note && !detectContacts(note).length ? note : 'Причина доступна в карточке сделки.'
        await this.notify.notify(client, userId, {
          kind: approve ? 'deal.verified' : 'deal.rejected', title: approve ? 'Сделка подтверждена' : 'Модератор не засчитал сделку',
          body: approve ? 'Модератор подтвердил исполнение сделки. Уровень проверки указан в вашем профиле.'
            : 'Модератор не засчитал сделку: ' + safeNote,
          payload: { dealId: id }, actions: [{ label: 'Открыть сделку', href: '/deals/' + id }], channels: ['EMAIL'],
        })
      }
      await this.event(client, deal.disclosure_id, actor.id, 'DEAL_VERIFIED',
        { dealId: id, chatId: deal.chat_id, approved: approve, note })
      await auditExchange(client, actor, 'deals', id, 'verified', undefined, { approved: approve }, note)
      return this.read(client, id, null)
    })
  }

  private async event(client: PoolClient, disclosureId: string, actor: string | null, type: 'DEAL_STATUS' | 'DEAL_VERIFIED', data: object) {
    await client.query(`
      INSERT INTO disclosure_events (disclosure_id,actor_user_id,type,data) VALUES ($1,$2,$3,$4)
    `, [disclosureId, actor, type, JSON.stringify(data)])
  }

  private async followups(client: PoolClient) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return { sent: 0 }
    const { rows: due } = await client.query<{
      id: string; seller_id: string; buyer_id: string; elapsed: number
    }>(`
      SELECT d.id,d.seller_id,d.buyer_id,extract(epoch FROM now()-d.created_at)::float8 / 86400 AS elapsed
      FROM deals d
      WHERE d.status IN ('NEGOTIATING','AGREED') AND (
        (d.created_at <= now() - interval '3 days' AND NOT (d.followups ? '3'))
        OR (d.created_at <= now() - interval '7 days' AND NOT (d.followups ? '7'))
        OR (d.created_at <= now() - interval '14 days' AND NOT (d.followups ? '14'))
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
          const token = await this.actions.issue(client, { purpose: 'deal.status', userId: user, subjectId: deal.id,
            expiresAt: new Date(Date.now() + 7 * 86_400_000) })
          await this.notify.notify(client, user, {
            kind: 'deal.followup', title, body: `С начала сделки прошло ${day} дней. Если статус изменился, обновите его в карточке сделки.`,
            payload: { dealId: deal.id, day }, actions: [
              ...(current.status === 'AGREED' ? [{ label: 'Подтвердить исполнение', href: '/deals/' + deal.id + '?status=EXECUTED' }]
                : [{ label: 'Указать условия', href: '/deals/' + deal.id + '?status=AGREED' }]),
              { label: 'Ответить', token, action: 'deal.status' },
              { label: 'Открыть сделку', href: '/deals/' + deal.id },
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
