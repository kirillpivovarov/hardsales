import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common'
import type { StaffSession } from '../auth/auth.types'
import { DatabaseService, type Queryable } from '../database/database.service'
import { auditExchange } from '../exchange/audit'
import { ExchangeNotifications } from '../exchange/notifications'
import { PlatformSettings } from '../exchange/platform-settings'
import { calendarDate, object, pageParams, Parameters, str, uuid } from '../market/market.inputs'
import { detectContacts, detectSplitContact, type ContactKind } from './detect'

export const hiddenContactMessage = 'Сообщение скрыто: в нём были контакты'
export const contactFieldMessage = 'Уберите контакты: они откроются после взаимного согласия'
export const chatBlockedMessage = 'Контакты откроются после взаимного согласия. Нажмите «Предложить обмен»'

type Surface = 'CHAT' | 'LISTING' | 'PROFILE' | 'REVIEW' | 'REPORT'
type Location = { peerId?: string; chatId?: string; listingId?: string }
type Attempt = Location & { userId: string; surface: Surface; body: string; kinds: ContactKind[] }

@Injectable()
export class ContactGuardService implements OnApplicationBootstrap {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications) {}

  enabled(db: Queryable = this.db) {
    return this.settings.enabled('feature_disclosure_journal', db)
  }

  async assertFields(userId: string | undefined, surface: Exclude<Surface, 'CHAT'>,
    fields: Record<string, unknown>, location: Location = {}) {
    if (!await this.enabled()) return
    await this.rejectFields(userId, surface, fields, location)
  }

  private async rejectFields(userId: string | undefined, surface: Exclude<Surface, 'CHAT'>,
    fields: Record<string, unknown>, location: Location = {}) {
    for (const [field, body] of Object.entries(fields)) {
      if (typeof body !== 'string' || !body.length || body.length > 8000 || body.includes('\0')) continue
      const kinds = detectContacts(body)
      if (!kinds.length) continue
      const warning = userId ? await this.db.transaction(client => this.block(client, {
        ...location, userId, surface, body, kinds,
      })) : false
      throw new BadRequestException({ code: 'CONTACT_IN_FIELD', message: contactFieldMessage, field, kinds, warning })
    }
  }

  async assertListing(data: unknown, uploads: number, userId?: string, listingId?: string) {
    if (!await this.enabled()) return
    const input = object(data)
    const fields: Record<string, unknown> = { title: input.title, description: input.description, stockCity: input.stockCity }
    if (input.specs !== undefined) {
      for (const [key, value] of Object.entries(object(input.specs, 'Характеристики'))) {
        fields[`spec:${key}`] = detectContacts(key).length ? key : value
      }
    }
    await this.rejectFields(userId, 'LISTING', fields, { listingId })
    if (uploads && input.imageContactAcknowledged !== true) {
      throw new BadRequestException({ code: 'PHOTO_CONTACT_CONFIRMATION_REQUIRED', field: 'images',
        message: 'Подтвердите, что на загружаемых фото нет контактов.' })
    }
  }

  async reportPhoto(userId: string, listingId: string, detailsInput: unknown) {
    const details = str(detailsInput ?? 'На фотографии объявления опубликованы контакты.', 'Опишите проблему', 10, 4000)
    if (!await this.enabled()) throw new NotFoundException('Жалобы на фотографии недоступны')
    await this.rejectFields(userId, 'REPORT', { details }, { listingId })
    const { rows: [report] } = await this.db.query(`
      INSERT INTO reports(listing_id, reporter_id, subject_id, reason, scope, details)
      SELECT l.id, $2, l.owner_id, 'CONTACT_PHOTO', 'ON_PLATFORM', $3 FROM listings l
      WHERE l.id = $1 AND l.owner_id <> $2 AND EXISTS (SELECT 1 FROM listing_images i WHERE i.listing_id = l.id)
      ON CONFLICT DO NOTHING RETURNING id, reason, status
    `, [listingId, userId, details])
    if (report) return report
    const { rowCount } = await this.db.query('SELECT 1 FROM reports WHERE listing_id = $1 AND reporter_id = $2 AND reason = $3',
      [listingId, userId, 'CONTACT_PHOTO'])
    if (rowCount) throw new ConflictException('Вы уже пожаловались на фотографии этого объявления')
    throw new ForbiddenException('Жалоба доступна только на фотографии чужого объявления')
  }

  async block(db: Queryable, attempt: Attempt): Promise<boolean> {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 62613))', [attempt.userId])
    const { rows: [counts] } = await db.query<{ day: number; week: number }>(`
      SELECT count(*) FILTER (WHERE e.created_at > now() - interval '24 hours')::int AS day,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM reports r
          WHERE r.subject_id = $1 AND r.reason = 'CONTACT_BYPASS' AND r.created_at >= e.created_at))::int AS week
      FROM contact_block_events e WHERE e.user_id = $1 AND e.created_at > now() - interval '7 days'
    `, [attempt.userId])
    await db.query(`
      INSERT INTO contact_block_events(user_id, peer_id, surface, chat_id, listing_id, kinds, body)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [attempt.userId, attempt.peerId ?? null, attempt.surface, attempt.chatId ?? null, attempt.listingId ?? null,
      attempt.kinds, attempt.body])

    if (counts.day === 2) {
      await this.notifications.notify(db, attempt.userId, {
        kind: 'contacts.repeated', title: 'Попытки обмена контактами',
        body: 'За последние сутки площадка остановила три попытки. Предлагайте обмен контактами в чате.',
      })
      const { rows: [admin] } = await db.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'")
      if (admin) await this.notifications.notify(db, admin.id, {
        kind: 'contacts.review', title: 'Попытки обмена контактами',
        body: 'Один участник трижды попытался передать контакты за сутки.',
        actions: [{ label: 'Попытки обхода', href: '/admin?section=exchange&part=contact-blocks&userId=' + attempt.userId }],
      })
    }
    if (counts.week >= 4) await db.query(`
      INSERT INTO reports(subject_id, reason, scope, details, chat_id, listing_id)
      VALUES ($1,'CONTACT_BYPASS','ON_PLATFORM','Зарегистрировано пять попыток передачи контактов за семь дней.',$2,$3)
      ON CONFLICT DO NOTHING
    `, [attempt.userId, attempt.chatId ?? null, attempt.listingId ?? null])
    return counts.day >= 2
  }

  async history(actor: StaffSession, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query)
    const params = new Parameters()
    const filters: string[] = []
    if (query.userId !== undefined && query.userId !== '') filters.push(`e.user_id = ${params.add(uuid(query.userId))}`)
    const from = query.from !== undefined && query.from !== '' ? calendarDate(query.from, 'Начало периода') : undefined
    const to = query.to !== undefined && query.to !== '' ? calendarDate(query.to, 'Конец периода') : undefined
    if (from && to && from > to) throw new BadRequestException('Начало периода должно быть не позднее конца')
    if (from || to) {
      const timezone = params.add(await this.settings.get<string>('timezone') ?? 'Europe/Moscow')
      if (from) filters.push(`e.created_at >= (${params.add(from)}::date::timestamp AT TIME ZONE ${timezone})`)
      if (to) filters.push(`e.created_at < ((${params.add(to)}::date + 1)::timestamp AT TIME ZONE ${timezone})`)
    }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : ''
    return this.db.transaction(async client => {
      const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM contact_block_events e ${where}`, [...params.values])
      const items = await client.query(`
        SELECT e.id, e.user_id AS "userId", u.display_name AS "displayName", e.peer_id AS "peerId", e.surface,
          e.chat_id AS "chatId", e.listing_id AS "listingId", e.kinds, e.body, e.created_at AS "createdAt",
          (SELECT count(*)::int FROM contact_block_events r WHERE r.user_id = e.user_id AND r.created_at > now() - interval '7 days') AS "weekCount"
        FROM contact_block_events e JOIN users u ON u.id = e.user_id ${where}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}
      `, params.values)
      if (items.rowCount) await auditExchange(client, actor, 'contact_blocks', 'list', 'contact-blocks-viewed', null, { page, count: items.rowCount })
      return { items: items.rows, total: count.rows[0].total, page, limit }
    })
  }

  async onApplicationBootstrap(): Promise<void> {
    while (await this.backfillBatch()) {
      // Each completed batch advances the shared cursor. A restart resumes at the next row.
    }
  }

  private async backfillBatch(): Promise<boolean> {
    return this.db.transaction(async client => {
      const { rows: [cursor] } = await client.query<{ last: string; through: string }>(`
        SELECT last_message_id AS last, through_message_id AS through FROM contact_guard_backfill WHERE singleton FOR UPDATE
      `)
      if (cursor.last === cursor.through) return false
      const { rows } = await client.query<{ id: string; body: string; disclosed: boolean; recent: string[] }>(`
        SELECT m.id, m.body,
          EXISTS (SELECT 1 FROM disclosures d WHERE d.user_a_id = least(c.owner_id, c.visitor_id)
            AND d.user_b_id = greatest(c.owner_id, c.visitor_id) AND d.accepted_at <= m.created_at) AS disclosed,
          ARRAY(SELECT r.body FROM chat_messages r WHERE r.chat_id = m.chat_id AND r.sender_id = m.sender_id
            AND r.id < m.id AND r.created_at > m.created_at - interval '10 minutes' ORDER BY r.id DESC LIMIT 5) AS recent
        FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE m.id > $1 AND m.id <= $2 ORDER BY m.id LIMIT 250
      `, [cursor.last, cursor.through])
      const hidden = rows.filter(row => !row.disclosed && (detectContacts(row.body).length ||
        detectSplitContact(row.recent.reverse(), row.body).length)).map(row => row.id)
      if (hidden.length) await client.query('UPDATE chat_messages SET hidden_for_peer = true WHERE id = ANY($1::bigint[])', [hidden])
      await client.query('UPDATE contact_guard_backfill SET last_message_id = $1 WHERE singleton',
        [rows.length < 250 ? cursor.through : rows.at(-1)!.id])
      return rows.length === 250
    })
  }
}
