import { Injectable, OnModuleInit } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { publicListingTitle } from '../contact-guard/public-text'
import { ExchangeActions } from './actions'
import { ActualityService } from './actuality.service'
import { ExchangeJobs } from './jobs'
import { ExchangeNotifications, type NotificationAction } from './notifications'
import { TrustService } from './trust.service'

const sweepLimit = 500
const dayMs = 24 * 60 * 60 * 1000
type Clock = { now: Date; timezone: string; day: string; hour: number }
type Question = {
  id: string
  title: string
  kind: 'BUY' | 'SELL'
  quantity: number
  price: string | null
  currency: string
  asked_at: Date
  expires_at: Date | null
}
type Due = {
  id: string
  title: string
  status: 'ACTIVE' | 'HIDDEN'
  asked_at: Date | null
  expires_at: Date | null
  hidden_at: Date | null
  hidden_reason: string | null
}

@Injectable()
export class ActualityJobs implements OnModuleInit {
  constructor(
    private readonly jobs: ExchangeJobs, private readonly actuality: ActualityService,
    private readonly notifications: ExchangeNotifications, private readonly actions: ExchangeActions,
    private readonly trust: TrustService,
  ) {}

  onModuleInit() {
    // Do not claim today's ask/reminder slot while the feature is disabled.
    this.jobs.register({
      name: 'actuality.sweep', lock: 11, enabled: () => this.actuality.enabled(), run: (client, clock) => this.sweep(client, clock),
    })
    this.jobs.register({
      name: 'actuality.ask', lock: 10, enabled: () => this.actuality.enabled(), slot: clock => clock.hour >= 10 ? clock.day : null,
      run: (client, clock, slot) => this.ask(client, clock, slot?.startsWith('manual:')),
    })
    this.jobs.register({
      name: 'actuality.remind', lock: 10, enabled: () => this.actuality.enabled(), slot: clock => clock.hour >= 16 ? clock.day : null,
      run: (client, clock, slot) => this.remind(client, clock, slot?.startsWith('manual:')),
    })
  }

  async ask(client: PoolClient, clock: Clock, manual = false) {
    if (!await this.actuality.enabled(client)) return { jobStatus: 'SKIPPED' as const, reason: 'disabled' }
    if (!manual && clock.hour >= 22) return { jobStatus: 'SKIPPED' as const, reason: 'late' }
    const { rows: owners } = await client.query<{ id: string }>(`
      SELECT DISTINCT u.id FROM users u JOIN listings l ON l.owner_id = u.id
      WHERE u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL AND u.actuality_suspended_at IS NULL
        AND l.status = 'ACTIVE' AND l.asked_at IS NULL ORDER BY u.id
    `, [])
    let asked = 0
    let notified = 0
    for (const { id: ownerId } of owners) {
      const { rows: [owner] } = await client.query(`
        SELECT id FROM users u WHERE id = $1 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL
          AND actuality_suspended_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM user_pauses p WHERE p.user_id = u.id AND ended_at IS NULL AND ends_at > $2
          ) FOR UPDATE
      `, [ownerId, clock.now])
      if (!owner) continue
      const { rows } = await client.query<Question>(`
        WITH ready AS (
          SELECT id FROM listings l WHERE owner_id = $1 AND status = 'ACTIVE' AND asked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $3)
            AND (delivery_by IS NULL OR delivery_by >= ($3::timestamptz AT TIME ZONE 'UTC')::date)
          ORDER BY id FOR UPDATE
        ), created AS (
          INSERT INTO listing_actuality_asks (listing_id, owner_id, local_date, asked_at)
          SELECT id, $1, $2::date, $3 FROM ready ON CONFLICT (listing_id, local_date) DO NOTHING RETURNING listing_id
        )
        UPDATE listings l SET asked_at = $3, reminded_at = NULL FROM created
        WHERE l.id = created.listing_id
        RETURNING l.id, l.title, l.kind, l.quantity, l.price, l.currency, l.asked_at, l.expires_at
      `, [ownerId, clock.day, clock.now])
      if (!rows.length) continue
      await this.notifyQuestions(client, ownerId, rows, clock, 'ask', manual)
      asked += rows.length
      notified++
    }
    return { asked, notified }
  }

  async remind(client: PoolClient, clock: Clock, manual = false) {
    if (!await this.actuality.enabled(client)) return { jobStatus: 'SKIPPED' as const, reason: 'disabled' }
    if (!manual) {
      const { rows: [asked] } = await client.query(`
        SELECT 1 FROM job_runs WHERE job = 'actuality.ask' AND slot = $1 AND status = 'DONE'
      `, [clock.day])
      if (!asked) return { jobStatus: 'SKIPPED' as const, reason: 'no-ask' }
    }
    const { rows: owners } = await client.query<{ id: string }>(`
      SELECT DISTINCT u.id FROM users u JOIN listings l ON l.owner_id = u.id
      WHERE u.status = 'ACTIVE' AND u.actuality_suspended_at IS NULL AND l.status = 'ACTIVE'
        AND l.asked_at BETWEEN $1::timestamptz - $2::int * interval '1 hour' AND $1 AND l.reminded_at IS NULL
      ORDER BY u.id
    `, [clock.now, manual ? 24 : 8])
    let reminded = 0
    let notified = 0
    for (const { id: ownerId } of owners) {
      const { rows: [owner] } = await client.query(`
        SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND actuality_suspended_at IS NULL FOR UPDATE
      `, [ownerId])
      if (!owner) continue
      const { rows } = await client.query<Question>(`
        UPDATE listings l SET reminded_at = $3
        FROM listing_actuality_asks a WHERE l.owner_id = $1 AND l.status = 'ACTIVE'
          AND l.asked_at BETWEEN $3::timestamptz - $5::int * interval '1 hour' AND $3 AND l.reminded_at IS NULL
          AND a.listing_id = l.id AND ($4::boolean OR a.local_date = $2::date) AND a.asked_at = l.asked_at
          AND a.answered_at IS NULL AND a.missed_at IS NULL
        RETURNING l.id, l.title, l.kind, l.quantity, l.price, l.currency, l.asked_at, l.expires_at
      `, [ownerId, clock.day, clock.now, manual, manual ? 24 : 8])
      if (!rows.length) continue
      await this.notifyQuestions(client, ownerId, rows, clock, 'remind', manual)
      reminded += rows.length
      notified++
    }
    return { reminded, notified }
  }

  async sweep(client: PoolClient, clock: Clock) {
    if (!await this.actuality.enabled(client)) return { processed: 0 }
    const { rows: owners } = await client.query<{ id: string }>(`
      SELECT u.id FROM users u WHERE u.status = 'ACTIVE' AND u.role IN ('BUYER','SELLER') AND (
        EXISTS (SELECT 1 FROM listings l WHERE l.owner_id = u.id AND l.status IN ('ACTIVE','HIDDEN') AND (
          l.expires_at <= $1 OR (l.status = 'ACTIVE' AND l.asked_at <= $1::timestamptz - interval '24 hours')
          OR (l.status = 'HIDDEN' AND l.hidden_reason = 'NO_ANSWER' AND l.hidden_at <= $1::timestamptz - interval '7 days')
          OR (u.actuality_suspended_at IS NOT NULL AND (l.status = 'ACTIVE' OR l.hidden_reason = 'NO_ANSWER'))
        )) OR EXISTS (SELECT 1 FROM user_pauses p WHERE p.user_id = u.id AND p.ended_at IS NULL AND p.ends_at <= $1)
        OR (EXISTS (SELECT 1 FROM listings l WHERE l.owner_id = u.id AND l.status = 'HIDDEN' AND l.hidden_reason = 'PAUSE')
          AND NOT EXISTS (SELECT 1 FROM user_pauses p WHERE p.user_id = u.id AND p.ended_at IS NULL))
      ) ORDER BY u.id LIMIT $2
    `, [clock.now, sweepLimit])
    let processed = 0
    for (const { id: ownerId } of owners) {
      if (processed >= sweepLimit) break
      const { rows: [owner] } = await client.query<{ actuality_suspended_at: Date | null }>(`
        SELECT actuality_suspended_at FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE SKIP LOCKED
      `, [ownerId])
      if (!owner) continue
      const { rows } = await client.query<Due>(`
        SELECT id, title, status, asked_at, expires_at, hidden_at, hidden_reason FROM listings
        WHERE owner_id = $1 AND status IN ('ACTIVE', 'HIDDEN') AND (
          expires_at <= $2 OR (status = 'ACTIVE' AND asked_at <= $2::timestamptz - interval '24 hours')
          OR (status = 'HIDDEN' AND hidden_reason = 'NO_ANSWER' AND hidden_at <= $2::timestamptz - interval '7 days')
          OR ($3::boolean AND (status = 'ACTIVE' OR hidden_reason = 'NO_ANSWER'))
        ) ORDER BY id LIMIT $4 FOR UPDATE SKIP LOCKED
      `, [ownerId, clock.now, Boolean(owner.actuality_suspended_at), sweepLimit - processed])
      const missed: Due[] = []
      const archived: Due[] = []
      for (const listing of rows) {
        if (listing.expires_at && listing.expires_at <= clock.now) {
          await this.archiveExpired(client, listing.id, clock, 'EXPIRED')
          archived.push(listing)
        } else if (owner.actuality_suspended_at) {
          await this.hideRestricted(client, [listing.id], clock.now)
        } else if (listing.status === 'HIDDEN') {
          await this.archiveExpired(client, listing.id, clock, 'HIDDEN_7D')
          archived.push(listing)
        } else {
          await client.query(`
            UPDATE listing_actuality_asks SET missed_at = $3, on_time = false
              WHERE listing_id = $1 AND asked_at = $2 AND answered_at IS NULL AND missed_at IS NULL
          `, [listing.id, listing.asked_at, clock.now])
          await client.query(`
            UPDATE listings SET status = 'HIDDEN', hidden_at = $2, hidden_reason = 'NO_ANSWER', updated_at = $2 WHERE id = $1
          `, [listing.id, clock.now])
          missed.push(listing)
        }
        processed++
      }
      if (archived.length) await this.listingDigest(client, ownerId, archived, clock, 'archived')
      if (missed.length) {
        const suspended = await this.actuality.missedDays(client, ownerId, clock.day) >= 3
        if (suspended) {
          await client.query('UPDATE users SET actuality_suspended_at = $2 WHERE id = $1', [ownerId, clock.now])
          await this.hideRestricted(client, missed.map(listing => listing.id), clock.now)
          const { rows: extra } = await client.query<{ id: string }>(`
            SELECT id FROM listings WHERE owner_id = $1 AND (status = 'ACTIVE' OR hidden_reason = 'NO_ANSWER')
            ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
          `, [ownerId, sweepLimit - processed])
          await this.hideRestricted(client, extra.map(listing => listing.id), clock.now)
          processed += extra.length
          await this.notifications.notify(client, ownerId, {
            kind: 'actuality.suspended', title: 'Три пропуска подтверждений',
            body: 'Три пропуска подтверждений за 30 дней: все ваши объявления скрыты. Верните их, когда будете на связи.',
            actions: [{ label: 'Я на связи', href: '/my-listings', action: 'actuality.resume' }],
            dedupeKey: `actuality.suspended:${ownerId}:${clock.day}`, channels: ['EMAIL'],
          })
        }
        if (!suspended) await this.listingDigest(client, ownerId, missed, clock, 'hidden')
        for (const listing of missed) await this.notifyChatHidden(client, listing, clock)
        await this.trust.refresh(client, ownerId)
      }
      processed += (await this.actuality.finishPause(client, ownerId, clock.now, sweepLimit - processed)).restored
    }
    return { processed }
  }

  private async hideRestricted(client: PoolClient, ids: string[], now: Date) {
    if (!ids.length) return
    await client.query(`
      UPDATE listings SET status = 'HIDDEN', hidden_at = $2, hidden_reason = 'MISSED3', updated_at = $2
      WHERE id = ANY($1::uuid[])
    `, [ids, now])
  }

  private async archiveExpired(client: PoolClient, listingId: string, clock: Clock, reason: 'EXPIRED' | 'HIDDEN_7D') {
    await client.query(`
      UPDATE listings SET status = 'ARCHIVED', archived_at = $2, archived_reason = $3, updated_at = $2 WHERE id = $1
    `, [listingId, clock.now, reason])
  }

  private async listingDigest(client: PoolClient, ownerId: string, listings: Pick<Due, 'id' | 'title'>[],
    clock: Clock, state: 'hidden' | 'archived') {
    const hidden = state === 'hidden'
    const kind = 'actuality.' + state
    const dedupeKey = `${kind}:${ownerId}:${clock.day}`
    const { rows: [existing] } = await client.query<{ id: string; payload: { listings: { id: string; title: string }[] } }>(
      'SELECT id,payload FROM notifications WHERE user_id=$1 AND dedupe_key=$2 FOR UPDATE', [ownerId, dedupeKey],
    )
    const items = new Map((existing?.payload.listings ?? []).map(item => [item.id, item]))
    for (const { id, title } of listings) items.set(id, { id, title })
    if (existing && existing.payload.listings.length === items.size) return
    const grammar = new Intl.PluralRules('ru').select(items.size)
    const noun = grammar === 'one' ? 'объявление' : grammar === 'few' ? 'объявления' : 'объявлений'
    const title = `${hidden ? 'Скрыто без ответа' : 'Перенесено в архив'}: ${items.size} ${noun}`
    const instruction = hidden ? 'Вернуть объявления можно в течение 7 дней.' : 'Объявления можно восстановить в разделе «Мои объявления».'
    const names = Array.from(items.values()).map(item => '• ' + item.title).join('\n')
    const body = [title, names.slice(0, 3700), instruction].join('\n\n')
    const payload = { count: items.size, listings: Array.from(items.values()) }
    if (existing) {
      await client.query('UPDATE notifications SET title=$2,body=$3,payload=$4,read_at=NULL WHERE id=$1',
        [existing.id, title, body, JSON.stringify(payload)])
    } else {
      await this.notifications.notify(client, ownerId, {
        kind, title, body, payload, dedupeKey, priority: 3, channels: ['EMAIL'],
        actions: [{ label: 'Мои объявления', href: '/my-listings', action: hidden ? 'listing.restore' : 'listing.open' }],
      })
    }
  }

  private async notifyChatHidden(client: PoolClient, listing: Due, clock: Clock) {
    const { rows: chats } = await client.query<{ id: string; visitor_id: string }>(`
      SELECT id, visitor_id FROM chats WHERE listing_id = $1
    `, [listing.id])
    for (const chat of chats) {
      await this.notifications.notify(client, chat.visitor_id, {
        kind: 'actuality.chat_hidden', title: 'Объявление скрыто',
        body: `«${publicListingTitle(listing.title)}» скрыто: автор не подтвердил актуальность. Переписку можно продолжить.`,
        payload: { listingId: listing.id, chatId: chat.id },
        actions: [{ label: 'Открыть чат', href: `/chats/${chat.id}`, action: 'chat.open' }],
        dedupeKey: `actuality.chat-hidden:${chat.id}:${clock.now.toISOString()}`,
      })
    }
  }

  async telegramStatus(client: PoolClient, ownerId: string): Promise<string | undefined> {
    const clock = await this.jobs.clock(client)
    const { rows } = await client.query<Question>(`
      SELECT l.id,l.title,l.kind,l.quantity,l.price,l.currency,l.asked_at,l.expires_at
      FROM listings l JOIN listing_actuality_asks a ON a.listing_id=l.id AND a.asked_at=l.asked_at
      WHERE l.owner_id=$1 AND l.status='ACTIVE' AND a.answered_at IS NULL AND a.missed_at IS NULL
        AND l.asked_at > now()-interval '24 hours'
    `, [ownerId])
    if (rows.length) {
      await this.notifyQuestions(client, ownerId, rows, clock, 'status')
      return undefined
    }
    const { rows: [done] } = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM listing_actuality_asks
      WHERE owner_id=$1 AND answer IN ('ACTUAL','CHANGED','EDITED') AND (answered_at AT TIME ZONE $2)::date=$3::date
    `, [ownerId, clock.timezone, clock.day])
    return `Все объявления подтверждены. Подтверждено сегодня: ${done.count}.`
  }

  private async notifyQuestions(client: PoolClient, ownerId: string, questions: Question[], clock: Clock,
    kind: 'ask' | 'remind' | 'status', manual = false) {
    questions.sort((a, b) => a.asked_at.getTime() - b.asked_at.getTime() || a.title.localeCompare(b.title))
    const firstDeadline = new Date(questions[0].asked_at.getTime() + dayMs)
    const options = { timeZone: clock.timezone, dateStyle: 'short', timeStyle: 'short' } as const
    const time = new Intl.DateTimeFormat('ru', options)
    const deadlines = `Ответьте до ${time.format(firstDeadline)} (${clock.timezone}), иначе объявления будут скрыты.`
    const body = [deadlines]
    const telegramLines = [deadlines]
    const actions: NotificationAction[] = []
    for (const listing of kind === 'status' ? questions.slice(0, 6) : questions) {
      const expiresAt = new Date(listing.asked_at.getTime() + dayMs)
      const token = await this.actions.issue(client, {
        purpose: 'listing.actuality', userId: ownerId, subjectId: listing.id,
        payload: { askedAt: listing.asked_at.toISOString() }, expiresAt,
      })
      const format = new Intl.NumberFormat('ru', { style: 'currency', currency: listing.currency })
      const unitPrice = listing.price === null ? null : Number(listing.price)
      const price = unitPrice === null ? 'по договорённости' : format.format(unitPrice) + ' за шт.'
        + (listing.quantity > 1 ? ` (${format.format(unitPrice * listing.quantity)} за ${listing.quantity} шт.)` : '')
      const line = `${listing.title} · ${listing.quantity} шт. · ${price}`
      body.push(line)
      if (telegramLines.length < 7) telegramLines.push(line)
      actions.push({ label: `Ответить · ${listing.title}`, token, action: 'listing.actuality' })
      if (kind !== 'remind' && listing.expires_at && listing.expires_at > clock.now && listing.expires_at <= expiresAt) {
        const extend = await this.actions.issue(client, {
          purpose: 'listing.extend', userId: ownerId, subjectId: listing.id, expiresAt: listing.expires_at,
        })
        const days = listing.kind === 'BUY' ? 21 : 14
        body.push(`Срок «${listing.title}» истекает ${time.format(listing.expires_at)}. Продлить на ${days} дн.?`)
        actions.push({ label: `Продлить · ${listing.title}`, token: extend, action: 'listing.extend', telegramLabel: `Продлить на ${days} дн.` })
      }
    }
    const all = await this.actions.issue(client, {
      purpose: 'listing.actuality-all', userId: ownerId, subjectId: ownerId,
      payload: { askedAtBefore: clock.now.toISOString() }, expiresAt: firstDeadline,
    })
    actions.unshift({ label: 'Все актуальны', token: all, action: 'listing.actuality-all' })
    const noticeKind = kind === 'status' ? 'actuality.bot_status' : `actuality.${kind}`
    await this.notifications.notify(client, ownerId, {
      kind: noticeKind, title: kind === 'status' ? `Ждут ответа: ${questions.length}`
        : kind === 'remind' ? 'Подтвердите актуальность объявлений' : 'Актуально?',
      body: body.join('\n').slice(0, 3990), payload: { listingIds: questions.map(row => row.id), deadlineAt: firstDeadline,
        telegramLines, questionCount: questions.length, manual },
      actions, dedupeKey: kind === 'status' ? undefined : `${noticeKind}:${ownerId}:${manual ? clock.now.toISOString() : clock.day}`,
      channels: kind === 'status' ? [] : ['EMAIL'],
    })
  }
}
