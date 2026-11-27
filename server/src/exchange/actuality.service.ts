import {
  BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { DatabaseService, type Queryable } from '../database/database.service'
import { MatchingService } from '../matching/matching.service'
import { integer, maxUnitPrice, object, oneOf, priceValue, str, uuid } from '../market/market.inputs'
import { lockListingPrices } from '../market/listing-price'
import { actualityEnabledSql, actualityRequestedSql, listingColumnsFor, listingJoins } from '../market/market.queries'
import { ExchangeActions } from './actions'
import { auditExchange } from './audit'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'
import { TrustService } from './trust.service'

const pauseLimit = 5
const daySeconds = 86400
const withdrawReasons = ['SOLD_PLATFORM', 'SOLD_OUTSIDE', 'CANCELLED'] as const
const answers = ['ACTUAL', 'CHANGED', 'WITHDRAWN'] as const
type Answer = typeof answers[number] | 'EDITED' | 'PAUSE'

interface OwnerRow {
  id: string
  actuality_suspended_at: Date | null
}
interface ListingRow {
  id: string
  title: string
  status: 'ACTIVE' | 'HIDDEN' | 'ARCHIVED' | 'FROZEN' | 'BANNED'
  kind: 'BUY' | 'SELL'
  asked_at: Date | null
  hidden_at: Date | null
  hidden_reason: 'NO_ANSWER' | 'MISSED3' | 'PAUSE' | 'SPOT_CHECK' | 'DUPLICATE' | null
  duplicate_of: string | null
  spot_check_hold: boolean
  confirmed_at: Date | null
  expires_at: Date | null
  price_mode: 'FIXED' | 'NEGOTIABLE'
  price: number | null
  quantity: number
  min_lot: number
}
interface Pause {
  startsAt: Date
  endsAt: Date
}

@Injectable()
export class ActualityService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly actions: ExchangeActions,
    private readonly matching: MatchingService,
    private readonly trust: TrustService,
    private readonly notifications: ExchangeNotifications,
  ) {}

  onModuleInit() {
    this.settings.onChange('feature_actuality', async (client, before, after) => {
      if (before !== true && after === true) await this.scheduleStart(client)
    })

    this.actions.register('listing.actuality', {
      lockSubjects: lockListingPrices,
      describe: async (client, token) => {
        const listing = await this.ownedListing(client, token.userId!, uuid(token.subjectId), false)
        return { title: listing.title, fields: {
          priceMode: listing.price_mode, price: listing.price, quantity: listing.quantity, minLot: listing.min_lot,
        } }
      },
      execute: (client, token, input) => this.answerInTransaction(
        client, token.userId!, uuid(token.subjectId), input, token.payload.askedAt,
      ),
    })
    this.actions.register('listing.actuality-all', {
      describe: async () => ({ title: 'Подтвердить все объявления, которые ждут ответа', fields: {} }),
      execute: (client, token) => this.confirmAllInTransaction(client, token.userId!, token.payload.askedAtBefore),
    })
    this.actions.register('listing.extend', {
      describe: async (client, token) => {
        const listing = await this.ownedListing(client, token.userId!, uuid(token.subjectId), false)
        const days = listing.kind === 'BUY' ? 21 : 14
        return { title: `Продлить «${listing.title}» на ${days} дн.`, fields: {} }
      },
      execute: (client, token) => this.extendInTransaction(client, token.userId!, uuid(token.subjectId)),
    })
  }

  async enabled(db: Queryable = this.db) {
    const { rows: [state] } = await db.query<{ enabled: boolean }>(`SELECT ${actualityEnabledSql} AS enabled`, [])
    return state.enabled
  }

  private async scheduleStart(client: PoolClient) {
    const timezone = await this.timezone(client)
    const { rows: [schedule] } = await client.query<{ startsAt: Date }>(`
      WITH minimum AS (SELECT now() + interval '72 hours' AS starts),
      first_day AS (SELECT starts, date_trunc('day', starts AT TIME ZONE $1) + interval '10 hours' AS local_start FROM minimum)
      INSERT INTO actuality_activation (starts_at)
      SELECT (local_start + CASE WHEN local_start AT TIME ZONE $1 < starts THEN interval '1 day' ELSE interval '0' END)
        AT TIME ZONE $1 FROM first_day
      ON CONFLICT (singleton) DO UPDATE SET starts_at = EXCLUDED.starts_at RETURNING starts_at AS "startsAt"
    `, [timezone])
    const date = new Intl.DateTimeFormat('ru', { timeZone: timezone, dateStyle: 'long' }).format(schedule.startsAt)
    const { rows: members } = await client.query<{ id: string }>(`
      SELECT id FROM users WHERE role IN ('BUYER', 'SELLER') AND status = 'ACTIVE' AND email_verified_at IS NOT NULL
      ORDER BY id
    `, [])
    for (const member of members) {
      await this.notifications.notify(client, member.id, {
        kind: 'actuality.announced', title: 'Скоро начнётся подтверждение актуальности',
        body: `С ${date} каждый день в 10:00 (${timezone}) площадка будет спрашивать, актуальны ли ваши объявления. Ответить можно одной кнопкой в письме или в разделе «Мои объявления». Без ответа за 24 часа объявление скрывается, вернуть его можно в течение 7 дней. Если уезжаете, поставьте паузу в профиле (до 5 дней в месяц).`,
        payload: { startsAt: schedule.startsAt, timezone },
        actions: [{ label: 'Мои объявления', href: '/my-listings', action: 'listing.open' }],
        dedupeKey: 'actuality.announced:' + schedule.startsAt.toISOString(), channels: ['EMAIL'],
      })
    }
    // Take owner references before listing locks, as the pause and sweep operations do.
    await client.query(`
      WITH open_listings AS (
        SELECT id FROM listings WHERE status = 'ACTIVE' AND asked_at IS NULL ORDER BY owner_id, id FOR UPDATE
      )
      UPDATE listings l SET expires_at = greatest(l.expires_at, $1::timestamptz + l.lifetime_days * interval '1 day')
      FROM open_listings WHERE l.id = open_listings.id
    `, [schedule.startsAt])
  }

  private async timezone(db: Queryable) {
    return await this.settings.get<string>('timezone', db) ?? 'Europe/Moscow'
  }

  async summary(ownerId: string) {
    return this.db.transaction(async client => {
      const { rows: [owner] } = await client.query<OwnerRow>(`
        SELECT id, actuality_suspended_at FROM users WHERE id = $1
      `, [ownerId])
      if (!owner) throw new NotFoundException('Профиль недоступен.')
      const timezone = await this.timezone(client)
      const { rows: [rollout] } = await client.query<{ enabled: boolean; startsAt: Date | null }>(`
        SELECT ${actualityEnabledSql} AS enabled, CASE WHEN ${actualityRequestedSql} THEN
          (SELECT starts_at FROM actuality_activation WHERE singleton AND starts_at > now()) END AS "startsAt"
      `, [])
      const { enabled, startsAt } = rollout
      const pause = await this.openPause(client, ownerId)
      const { rows: [dates] } = await client.query<{ now: Date; local_day: string }>(`
        SELECT now() AS now, (now() AT TIME ZONE $1)::date::text AS local_day
      `, [timezone])
      const pauseSeconds = await this.pauseSeconds(client, ownerId, timezone, dates.now)
      const missedDays30 = await this.missedDays(client, ownerId, dates.local_day)
      const { rows: pending } = enabled ? await client.query<{
        id: string; title: string; askedAt: Date; deadlineAt: Date
      }>(`
        SELECT id, title, asked_at AS "askedAt", asked_at + interval '24 hours' AS "deadlineAt"
        FROM listings WHERE owner_id = $1 AND status = 'ACTIVE' AND asked_at IS NOT NULL
        ORDER BY asked_at, id
      `, [ownerId]) : { rows: [] }
      return {
        enabled, startsAt, timezone, pending, deadlineAt: pending[0]?.deadlineAt ?? null,
        suspended: owner.actuality_suspended_at !== null, pause,
        pauseDaysLeft: Math.max(0, pauseLimit - Math.ceil(pauseSeconds / daySeconds)), missedDays30,
      }
    })
  }

  async assertCanActivate(client: PoolClient, ownerId: string) {
    const { rows: [owner] } = await client.query<OwnerRow>(`
      SELECT id, actuality_suspended_at FROM users WHERE id = $1
    `, [ownerId])
    if (!owner) throw new NotFoundException('Профиль недоступен.')
    if (owner.actuality_suspended_at) throw new ConflictException('Сначала нажмите «Я на связи».')
    if (await this.openPause(client, ownerId)) throw new ConflictException('Сейчас пауза.')
  }

  async recordOwnerEdit(client: PoolClient, listingId: string) {
    if (!await this.enabled(client)) return
    await this.closeQuestion(client, listingId, 'EDITED')
    await client.query(`
      UPDATE listings SET confirmed_at = now(), asked_at = NULL, reminded_at = NULL
      WHERE id = $1 AND status = 'ACTIVE'
    `, [listingId])
  }

  async ownerArchive(client: PoolClient, ownerId: string, listingId: string, restore: boolean) {
    const listing = await this.ownedListing(client, ownerId, listingId)
    if (listing.status === 'FROZEN' || listing.status === 'BANNED') {
      throw new ForbiddenException('Объявление ограничено модератором.')
    }
    if (!restore) {
      if (listing.status === 'ARCHIVED') return
      if (listing.status === 'ACTIVE') await this.closeQuestion(client, listingId, 'WITHDRAWN')
      await client.query(`
        UPDATE listings SET status = 'ARCHIVED', archived_at = now(), archived_reason = 'OWNER',
          updated_at = now() WHERE id = $1
      `, [listingId])
      return
    }
    if (listing.duplicate_of) throw new ConflictException('Объявление помечено как дубль. Оспорить решение можно у модератора.')
    if (listing.status === 'ACTIVE') return
    if (listing.spot_check_hold) throw new ConflictException('Объявление скрыто до завершения проверки.')
    await this.assertCanActivate(client, ownerId)
    if (listing.status === 'HIDDEN') {
      if (listing.hidden_reason === 'SPOT_CHECK') throw new ConflictException('Объявление скрыто до завершения проверки.')
      if (listing.hidden_reason === 'MISSED3') throw new ConflictException('Сначала нажмите «Я на связи».')
      if (listing.hidden_reason === 'NO_ANSWER' && listing.hidden_at &&
          listing.hidden_at.getTime() < Date.now() - 7 * daySeconds * 1000) {
        throw new ConflictException('Прошло больше 7 дней: объявление в архиве.')
      }
    }
    await client.query(`
      UPDATE listings SET status = 'ACTIVE', confirmed_at = now(), updated_at = now(),
        expires_at = CASE WHEN status = 'ARCHIVED' THEN now() + lifetime_days * interval '1 day' ELSE expires_at END
      WHERE id = $1
    `, [listingId])
  }

  answer(ownerId: string, id: string, input: unknown) {
    return this.db.transaction(client => this.answerInTransaction(client, ownerId, uuid(id), input))
  }

  extend(ownerId: string, id: string) {
    return this.db.transaction(client => this.extendInTransaction(client, ownerId, uuid(id)))
  }

  confirmAll(ownerId: string) {
    return this.db.transaction(client => this.confirmAllInTransaction(client, ownerId))
  }

  async startPause(ownerId: string, raw: unknown) {
    const days = integer(object(raw).days, 'Дни паузы', 1, 365)
    return this.db.transaction(async client => {
      await this.assertEnabled(client)
      await this.lockOwner(client, ownerId)
      if (await this.openPause(client, ownerId)) throw new ConflictException('Пауза уже действует.')
      await this.finishPause(client, ownerId, new Date())
      const timezone = await this.timezone(client)
      const { rows: [span] } = await client.query<{ startsAt: Date; endsAt: Date; secondsInMonth: number }>(`
        WITH local_time AS (SELECT now() AT TIME ZONE $1 AS starts)
        SELECT starts AT TIME ZONE $1 AS "startsAt",
          (starts + $2::int * interval '1 day') AT TIME ZONE $1 AS "endsAt",
          extract(epoch FROM (least(starts + $2::int * interval '1 day',
            date_trunc('month', starts) + interval '1 month') - starts))::float8 AS "secondsInMonth"
        FROM local_time
      `, [timezone, days])
      const spent = await this.pauseSeconds(client, ownerId, timezone, span.startsAt)
      if (spent + span.secondsInMonth > pauseLimit * daySeconds ||
          days * daySeconds - span.secondsInMonth > pauseLimit * daySeconds) {
        throw new ConflictException(`В этом месяце осталось ${Math.max(0, pauseLimit - Math.ceil(spent / daySeconds))} дн. паузы.`)
      }
      const { rows: [pause] } = await client.query<Pause>(`
        INSERT INTO user_pauses (user_id, starts_at, ends_at) VALUES ($1, $2, $3)
        RETURNING starts_at AS "startsAt", ends_at AS "endsAt"
      `, [ownerId, span.startsAt, span.endsAt])
      // Lock listings before question rows, the same order as single-listing actions.
      await client.query(`
        SELECT id FROM listings WHERE owner_id = $1 AND status = 'ACTIVE' ORDER BY id FOR UPDATE
      `, [ownerId])
      await client.query(`
        UPDATE listing_actuality_asks a SET answered_at = now(), answer = 'PAUSE', on_time = true
        FROM listings l WHERE l.owner_id = $1 AND l.status = 'ACTIVE' AND a.listing_id = l.id
          AND a.asked_at = l.asked_at AND a.answered_at IS NULL AND a.missed_at IS NULL
      `, [ownerId])
      await client.query(`
        UPDATE listings SET status = 'HIDDEN', hidden_reason = 'PAUSE', hidden_at = now(), updated_at = now()
        WHERE owner_id = $1 AND status = 'ACTIVE'
      `, [ownerId])
      await this.trust.refresh(client, ownerId)
      return { pause }
    })
  }

  endPause(ownerId: string) {
    return this.db.transaction(async client => {
      await this.lockOwner(client, ownerId)
      if (!(await this.finishPause(client, ownerId, new Date())).ended) throw new ConflictException('Паузы нет.')
      return { ended: true }
    })
  }

  async finishPause(client: PoolClient, ownerId: string, now: Date, limit?: number) {
    const sweep = limit !== undefined
    const result = await client.query(`
      UPDATE user_pauses SET ended_at = least($2, ends_at)
      WHERE user_id = $1 AND ended_at IS NULL AND (NOT $3::boolean OR ends_at <= $2)
    `, [ownerId, now, sweep])
    const ended = Boolean(result.rowCount)
    if ((!ended && !sweep) || limit === 0) return { ended, restored: 0 }
    const restored = await client.query(`
      WITH ready AS (
        SELECT id FROM listings l WHERE owner_id = $1 AND status = 'HIDDEN' AND hidden_reason = 'PAUSE'
          AND NOT EXISTS (SELECT 1 FROM user_pauses p WHERE p.user_id = l.owner_id AND p.ended_at IS NULL)
        ORDER BY id LIMIT $3 FOR UPDATE ${sweep ? 'SKIP LOCKED' : ''}
      )
      UPDATE listings l SET status = CASE WHEN u.actuality_suspended_at IS NULL THEN 'ACTIVE' ELSE 'HIDDEN' END,
        confirmed_at = $2, updated_at = $2,
        hidden_reason = CASE WHEN u.actuality_suspended_at IS NOT NULL THEN 'MISSED3' END,
        hidden_at = CASE WHEN u.actuality_suspended_at IS NOT NULL THEN $2::timestamptz END
      FROM users u, ready WHERE l.id = ready.id AND u.id = l.owner_id
    `, [ownerId, now, limit ?? null])
    return { ended, restored: restored.rowCount ?? 0 }
  }

  resume(ownerId: string) {
    return this.db.transaction(async client => {
      await this.lockOwner(client, ownerId)
      return this.resumeInTransaction(client, ownerId)
    })
  }

  async staffResume(actor: StaffSession<'ADMIN'>, idInput: string, raw: unknown) {
    const ownerId = uuid(idInput)
    const reason = str(object(raw).reason, 'Причина', 3, 500)
    return this.db.transaction(async client => {
      const { rows: [staff] } = await client.query<{ username: string }>(`
        SELECT username FROM users WHERE id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'
          AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE
      `, [actor.id])
      const { rows: [session] } = await client.query(`
        SELECT 1 FROM auth_sessions WHERE user_id = $1 AND token_hash = $2
          AND expires_at > clock_timestamp() FOR SHARE
      `, [actor.id, actor.sessionHash])
      if (!staff || !session) throw new ForbiddenException('Сеанс сотрудника завершён. Войдите снова.')
      await this.lockOwner(client, ownerId, false)
      const { restored } = await this.resumeInTransaction(client, ownerId)
      await auditExchange(client, { id: actor.id, role: 'ADMIN', username: staff.username }, 'users', ownerId,
        'actuality-resumed', { suspended: true }, { suspended: false, restored }, reason)
      const { rows: [user] } = await client.query(`
        SELECT id, username, display_name AS "displayName", role, status, false AS "actualitySuspended", $2::int AS restored
        FROM users WHERE id = $1
      `, [ownerId, restored])
      return user
    })
  }

  async missedDays(client: Queryable, ownerId: string, localDay: string) {
    const { rows: [count] } = await client.query<{ total: number }>(`
      SELECT count(DISTINCT local_date)::int AS total
      FROM listing_actuality_asks WHERE owner_id = $1 AND missed_at IS NOT NULL
        AND local_date BETWEEN $2::date - 29 AND $2::date
    `, [ownerId, localDay])
    return count.total
  }

  async lockOwner(client: PoolClient, ownerId: string, active = true) {
    const { rows: [owner] } = await client.query<OwnerRow>(`
      SELECT id, actuality_suspended_at FROM users WHERE id = $1 AND role IN ('BUYER', 'SELLER')
        AND (NOT $2::boolean OR (status = 'ACTIVE' AND email_verified_at IS NOT NULL)) FOR UPDATE
    `, [ownerId, active])
    if (!owner) throw new NotFoundException('Профиль недоступен.')
    return owner
  }

  private async resumeInTransaction(client: PoolClient, ownerId: string) {
    const updated = await client.query(`
      UPDATE users SET actuality_suspended_at = NULL WHERE id = $1 AND actuality_suspended_at IS NOT NULL
    `, [ownerId])
    if (!updated.rowCount) throw new ConflictException('Ограничения нет.')
    const activePause = Boolean(await this.openPause(client, ownerId))
    const restored = await client.query(`
      UPDATE listings SET status = CASE WHEN $2::boolean THEN 'HIDDEN' ELSE 'ACTIVE' END,
        hidden_reason = CASE WHEN $2 THEN 'PAUSE' END, hidden_at = CASE WHEN $2 THEN now() END,
        confirmed_at = now(), updated_at = now()
      WHERE owner_id = $1 AND status = 'HIDDEN' AND hidden_reason = 'MISSED3'
    `, [ownerId, activePause])
    return { restored: restored.rowCount ?? 0 }
  }

  private async openPause(client: Queryable, ownerId: string) {
    const { rows: [pause] } = await client.query<Pause>(`
      SELECT starts_at AS "startsAt", ends_at AS "endsAt"
      FROM user_pauses WHERE user_id = $1 AND ended_at IS NULL AND ends_at > now()
    `, [ownerId])
    return pause ?? null
  }

  private async pauseSeconds(client: Queryable, ownerId: string, timezone: string, now: Date) {
    const { rows: [usage] } = await client.query<{ seconds: number }>(`
      WITH month AS (SELECT date_trunc('month', $3::timestamptz AT TIME ZONE $2) AS starts)
      SELECT COALESCE(sum(extract(epoch FROM greatest(interval '0 seconds',
        least(least(ends_at, coalesce(ended_at, ends_at)) AT TIME ZONE $2, month.starts + interval '1 month') -
          greatest(starts_at AT TIME ZONE $2, month.starts)
      ))), 0)::float8 AS seconds
      FROM user_pauses CROSS JOIN month WHERE user_id = $1
    `, [ownerId, timezone, now])
    return usage.seconds
  }

  private async answerInTransaction(client: PoolClient, ownerId: string, id: string, raw: unknown, expectedAskedAt?: unknown) {
    await this.assertEnabled(client)
    await lockListingPrices(client)
    await this.lockOwner(client, ownerId)
    const listing = await this.ownedListing(client, ownerId, id)
    if (listing.status !== 'ACTIVE') {
      if (expectedAskedAt) throw new GoneException('Срок ссылки истёк. Вы можете вернуть объявление в разделе «Мои объявления».')
      throw new ConflictException(listing.status === 'HIDDEN' ? 'Объявление скрыто. Сначала верните его.' : 'Объявление недоступно.')
    }
    const input = object(raw)
    const answer = oneOf(input.answer, answers, 'Ответ')
    if (typeof expectedAskedAt === 'string' && listing.asked_at?.toISOString() !== expectedAskedAt) {
      return this.show(client, id)
    }
    if (answer === 'CHANGED') {
      if (input.price === undefined && input.quantity === undefined) throw new BadRequestException('Укажите новую цену или количество.')
      if (input.price !== undefined && listing.price_mode === 'NEGOTIABLE') {
        throw new BadRequestException('У объявления договорная цена: измените условия цены в форме.')
      }
      const price = input.price === undefined ? listing.price : priceValue(input.price, 'Цена за шт.', 0.01, maxUnitPrice)
      const quantity = input.quantity === undefined ? listing.quantity : integer(input.quantity, 'Количество', 1, 1_000_000)
      if (quantity < listing.min_lot) throw new BadRequestException('Количество меньше минимальной партии. Измените её в объявлении.')
      await client.query("SELECT set_config('hwforai.listing_change_source', 'ACTUALITY', true)")
      await client.query('UPDATE listings SET price = $2, quantity = $3, updated_at = now() WHERE id = $1', [id, price, quantity])
      await client.query("SELECT set_config('hwforai.listing_change_source', '', true)")
    }
    await this.closeQuestion(client, id, answer)
    let dealId: string | undefined
    if (answer === 'WITHDRAWN') {
      const reason = oneOf(input.reason, withdrawReasons, 'Причина')
      await client.query(`
        UPDATE listings SET status = 'ARCHIVED', archived_at = now(), archived_reason = $2, updated_at = now()
        WHERE id = $1
      `, [id, reason])
      if (reason === 'SOLD_PLATFORM' && await this.settings.enabled('feature_trust_rating', client)) {
        const { rows: [deal] } = await client.query<{ id: string }>(`
          SELECT id FROM deals WHERE status IN ('AGREED', 'NEGOTIATING') AND
            ((sell_listing_id = $1 AND seller_id = $2) OR (buy_listing_id = $1 AND buyer_id = $2))
          ORDER BY (status = 'AGREED') DESC, created_at DESC, id LIMIT 1
        `, [id, ownerId])
        dealId = deal?.id
      }
    } else {
      const timezone = await this.timezone(client)
      await client.query(`
        UPDATE listings SET confirmed_at = now(), asked_at = NULL, reminded_at = NULL
        WHERE id = $1 AND ($2::boolean OR asked_at IS NOT NULL OR confirmed_at IS NULL
          OR (confirmed_at AT TIME ZONE $3)::date <> (now() AT TIME ZONE $3)::date)
      `, [id, answer === 'CHANGED', timezone])
    }
    await this.trust.refresh(client, ownerId)
    await this.matching.recomputeListing(client, id)
    const result = await this.show(client, id)
    return dealId ? { ...result, dealId } : result
  }

  private async confirmAllInTransaction(client: PoolClient, ownerId: string, before?: unknown) {
    await this.assertEnabled(client)
    await this.lockOwner(client, ownerId)
    const cutoff = typeof before === 'string' ? new Date(before) : null
    const { rows } = await client.query<{ id: string }>(`
      SELECT id FROM listings WHERE owner_id = $1 AND status = 'ACTIVE' AND asked_at IS NOT NULL
        AND ($2::timestamptz IS NULL OR asked_at <= $2)
      ORDER BY id FOR UPDATE
    `, [ownerId, cutoff])
    if (!rows.length) return { confirmed: 0 }
    const ids = rows.map(row => row.id)
    await client.query(`
      UPDATE listing_actuality_asks a SET answered_at = now(), answer = 'ACTUAL',
        on_time = now() - a.asked_at <= interval '24 hours'
      FROM listings l WHERE l.id = ANY($1::uuid[]) AND a.listing_id = l.id AND a.asked_at = l.asked_at
        AND a.answered_at IS NULL AND a.missed_at IS NULL
    `, [ids])
    await client.query(`
      UPDATE listings SET confirmed_at = now(), asked_at = NULL, reminded_at = NULL WHERE id = ANY($1::uuid[])
    `, [ids])
    await this.trust.refresh(client, ownerId)
    for (const id of ids) await this.matching.recomputeListing(client, id)
    return { confirmed: ids.length }
  }

  private async extendInTransaction(client: PoolClient, ownerId: string, id: string) {
    await this.assertEnabled(client)
    await this.lockOwner(client, ownerId)
    const listing = await this.ownedListing(client, ownerId, id)
    if (listing.status !== 'ACTIVE' && listing.status !== 'HIDDEN') {
      throw new ConflictException('Продлить можно активное или скрытое объявление.')
    }
    await client.query(`
      UPDATE listings SET expires_at = greatest(expires_at, now()) + $2::int * interval '1 day',
        updated_at = now() WHERE id = $1
    `, [id, listing.kind === 'BUY' ? 21 : 14])
    await this.matching.recomputeListing(client, id)
    return this.show(client, id)
  }

  private async closeQuestion(client: PoolClient, id: string, answer: Answer) {
    await client.query(`
      UPDATE listing_actuality_asks a SET answered_at = now(), answer = $2,
        on_time = now() - a.asked_at <= interval '24 hours'
      FROM listings l WHERE l.id = $1 AND a.listing_id = l.id AND a.asked_at = l.asked_at
        AND a.answered_at IS NULL AND a.missed_at IS NULL
    `, [id, answer])
  }

  private async ownedListing(db: Queryable, ownerId: string, id: string, lock = true) {
    const { rows: [listing] } = await db.query<ListingRow>(`
      SELECT id, title, status, kind, asked_at, hidden_at, hidden_reason, duplicate_of, spot_check_hold, expires_at, confirmed_at, price_mode,
        price::float8 AS price, quantity, min_lot
      FROM listings WHERE id = $1 AND owner_id = $2 ${lock ? 'FOR UPDATE' : ''}
    `, [id, ownerId])
    if (!listing) throw new NotFoundException('Объявление не найдено.')
    return listing
  }

  private async show(db: Queryable, id: string) {
    const { rows: [listing] } = await db.query(`
      SELECT ${listingColumnsFor('true')} ${listingJoins} WHERE l.id = $1
    `, [id])
    if (!listing) throw new NotFoundException('Объявление не найдено.')
    return listing
  }

  private async assertEnabled(db: Queryable) {
    if (!await this.enabled(db)) throw new NotFoundException('Подтверждение актуальности пока отключено.')
  }
}
