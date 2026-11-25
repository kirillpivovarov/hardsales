import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common'
import type { SessionUser } from '../auth/auth.types'
import { outsideContact, withContact } from '../contact'
import { DatabaseService, type Queryable } from '../database/database.service'
import { integer, object, oneOf, pageParams, str, uuid } from './market.inputs'
import { listingPublicWhere, publicProfile, visibleCategories } from './market.queries'

type ChatContext = {
  id: string
  owner_id: string
  visitor_id: string
  reveal_state: 'NONE' | 'REQUESTED' | 'ACCEPTED' | 'DECLINED'
  reveal_requested_by: string | null
  owner_telegram_version: string | null
  visitor_telegram_version: string | null
  owner_version: string
  visitor_version: string
  owner_current: string | null
  visitor_current: string | null
  active: boolean
}

const messages = `m.id::float8 AS id, m.sender_id AS "senderId", m.body, m.contact_warning AS "contactWarning", m.created_at AS "createdAt"`
const chatJoins = `FROM chats c
  JOIN listings l ON l.id = c.listing_id
  JOIN users owner ON c.owner_id = owner.id
  JOIN users visitor ON c.visitor_id = visitor.id
  JOIN users partner ON partner.id = CASE WHEN c.owner_id = $1 THEN c.visitor_id ELSE c.owner_id END
`
const memberWhere = '(c.owner_id = $1 OR c.visitor_id = $1)'
const chatActive = `owner.status = 'ACTIVE' AND visitor.status = 'ACTIVE' AND
  owner.email_verified_at IS NOT NULL AND visitor.email_verified_at IS NOT NULL AND
  l.status NOT IN ('FROZEN', 'BANNED')`
const consentStale = `c.reveal_state IN ('REQUESTED', 'ACCEPTED') AND
  (owner.telegram_version IS DISTINCT FROM c.owner_telegram_version OR
    visitor.telegram_version IS DISTINCT FROM c.visitor_telegram_version)`
const validConsent = `c.reveal_state = 'ACCEPTED' AND NOT (${consentStale})`
const reviewCheck = `EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id = $1)
  AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id = partner.id)`
const chatColumns = `
  c.id, c.created_at AS "createdAt",
  jsonb_build_object('id', l.id, 'title', l.title, 'status', l.status, 'kind', l.kind) AS listing,
  ${publicProfile('partner')} AS partner,
  (SELECT jsonb_build_object('id', m.id, 'body', m.body, 'senderId', m.sender_id, 'createdAt', m.created_at)
    FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessage",
  (SELECT count(*)::int FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id != $1 AND
    m.id > CASE WHEN c.owner_id = $1 THEN c.owner_read_id ELSE c.visitor_read_id END) AS "unreadCount",
  CASE WHEN ${consentStale} THEN 'NONE' ELSE c.reveal_state END AS "revealState",
  CASE WHEN ${consentStale} THEN NULL ELSE c.reveal_requested_by END AS "revealRequestedBy",
  CASE WHEN ${chatActive} AND ${validConsent} THEN jsonb_build_object(
    'mine', CASE WHEN c.owner_id = $1 THEN owner.telegram ELSE visitor.telegram END,
    'partner', CASE WHEN c.owner_id = $1 THEN visitor.telegram ELSE owner.telegram END
  ) ELSE NULL END AS telegram,
  CASE WHEN ${chatActive} THEN 'ACTIVE' ELSE 'RESTRICTED' END AS status,
  EXISTS (SELECT 1 FROM reviews r WHERE r.chat_id = c.id AND r.author_id = $1) AS "hasReview",
  EXISTS (SELECT 1 FROM reports r WHERE r.chat_id = c.id AND r.reporter_id = $1) AS "hasReport",
  EXISTS (SELECT 1 FROM chat_contact_exchanges e WHERE e.chat_id = c.id) AS "canReportTelegram",
  (${chatActive} AND ${reviewCheck}
    AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.chat_id = c.id AND r.author_id = $1)) AS "canReview"
`

@Injectable()
export class ChatsService {
  constructor(private readonly db: DatabaseService) {}

  async list(user: SessionUser, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query, 30)
    const [rows, count] = await Promise.all([
      this.db.query(`
        SELECT ${chatColumns} ${chatJoins} WHERE ${memberWhere}
        ORDER BY coalesce((SELECT max(m.created_at) FROM chat_messages m WHERE m.chat_id = c.id),
          c.created_at) DESC, c.id LIMIT $2 OFFSET $3
      `, [user.id, limit, offset]),
      this.db.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM chats c WHERE ${memberWhere}
      `, [user.id]),
    ])
    return { items: rows.rows, total: count.rows[0].total, page, limit }
  }

  async detail(user: SessionUser, idInput: string) {
    return this.show(this.db, user.id, uuid(idInput))
  }

  async create(user: SessionUser, raw: unknown) {
    if (user.role === 'ADMIN') throw new ForbiddenException('Чаты доступны участникам рынка')
    const listingId = uuid(object(raw).listingId, 'Объявление')
    return this.db.transaction(async client => {
      const { rows } = await client.query<{ id: string; owner_id: string; counterparty: string; actor_type: string }>(`
        ${visibleCategories}
        SELECT l.id, l.owner_id, l.counterparty, actor.participant_type AS actor_type
        FROM listings l JOIN users u ON u.id = l.owner_id
        JOIN users actor ON actor.id = $3 AND actor.status = 'ACTIVE' AND actor.email_verified_at IS NOT NULL
        WHERE l.id = $1 AND l.kind = $2 AND l.owner_id != $3 AND ${listingPublicWhere}
        FOR SHARE OF l, u, actor
      `, [listingId, user.role === 'SELLER' ? 'BUY' : 'SELL', user.id])
      const listing = rows[0]
      if (!listing) throw new NotFoundException('Объявление недоступно')
      if (listing.counterparty === 'COMPANY' && listing.actor_type !== 'COMPANY') {
        throw new ForbiddenException('Автор объявления принимает предложения только от компаний')
      }
      await client.query(`
        INSERT INTO chats (listing_id, owner_id, visitor_id)
        VALUES ($1, $2, $3) ON CONFLICT (listing_id, visitor_id) DO NOTHING
      `, [listingId, listing.owner_id, user.id])
      const chat = await client.query<{ id: string }>(
        'SELECT id FROM chats WHERE listing_id = $1 AND visitor_id = $2', [listingId, user.id],
      )
      return this.show(client, user.id, chat.rows[0].id)
    })
  }

  async history(user: SessionUser, idInput: string, query: Record<string, unknown>) {
    const id = uuid(idInput)
    await this.context(this.db, user.id, id)
    const limit = query.limit === undefined ? 100 : integer(query.limit, 'Размер истории', 1, 100)
    const before = query.before === undefined ? null : integer(query.before, 'Сообщение', 1, Number.MAX_SAFE_INTEGER)
    const after = query.after === undefined ? null : integer(query.after, 'Сообщение', 0, Number.MAX_SAFE_INTEGER)
    if (before !== null && after !== null) throw new BadRequestException('Укажите только одну границу истории')
    const { rows } = await this.db.query(`
      SELECT * FROM (
        SELECT ${messages} FROM chat_messages m
        WHERE m.chat_id = $1 AND ($2::bigint IS NULL OR m.id < $2) AND ($3::bigint IS NULL OR m.id > $3)
        ORDER BY m.id ${after === null ? 'DESC' : 'ASC'} LIMIT $4
      ) result ORDER BY id
    `, [id, before, after, limit])
    return rows
  }

  async send(user: SessionUser, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = str(object(raw).body, 'Сообщение', 1, 4000)
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      const confirmed = context.reveal_state === 'ACCEPTED' && this.consentMatches(context)
        ? [context.owner_current, context.visitor_current] : []
      const { rows: recent } = await client.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM chat_messages
        WHERE chat_id = $1 AND sender_id = $2 AND created_at > now() - interval '1 minute'
      `, [id, user.id])
      if (recent[0].total >= 30) throw new HttpException('Слишком много сообщений. Попробуйте через минуту.', 429)
      const { rows } = await client.query(`
        INSERT INTO chat_messages AS m (chat_id, sender_id, body, contact_warning)
        VALUES ($1, $2, $3, $4) RETURNING ${messages}
      `, [id, user.id, body, withContact(body, confirmed)])
      return rows[0]
    })
  }

  async read(user: SessionUser, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = raw === undefined ? {} : object(raw)
    const messageId = body.messageId === undefined ? null : integer(body.messageId, 'Сообщение', 1, Number.MAX_SAFE_INTEGER)
    const { rowCount } = await this.db.query(`
      UPDATE chats c SET
        owner_read_id = CASE WHEN c.owner_id = $1 THEN greatest(c.owner_read_id, position.id) ELSE c.owner_read_id END,
        visitor_read_id = CASE WHEN c.visitor_id = $1 THEN greatest(c.visitor_read_id, position.id) ELSE c.visitor_read_id END
      FROM (SELECT coalesce(max(m.id), 0) AS id FROM chat_messages m
        WHERE m.chat_id = $2 AND m.sender_id != $1 AND ($3::bigint IS NULL OR m.id <= $3)) position
      WHERE c.id = $2 AND ${memberWhere}
    `, [user.id, id, messageId])
    if (!rowCount) throw new NotFoundException('Чат не найден')
  }

  async reveal(user: SessionUser, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const action = oneOf(object(raw).action, ['REQUEST', 'ACCEPT', 'DECLINE'], 'Действие')
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      const stale = (context.reveal_state === 'ACCEPTED' || context.reveal_state === 'REQUESTED') &&
        !this.consentMatches(context)
      if (action === 'REQUEST') {
        if (!stale && (context.reveal_state === 'REQUESTED' || context.reveal_state === 'ACCEPTED')) {
          throw new ConflictException('Запрос уже сделан')
        }
        if (!context.owner_current || !context.visitor_current) throw new ConflictException('Обоим участникам нужен привязанный Telegram')
        await client.query(`
          UPDATE chats SET reveal_state = 'REQUESTED', reveal_requested_by = $2,
            owner_telegram_version = $3, visitor_telegram_version = $4 WHERE id = $1
        `, [id, user.id, context.owner_version, context.visitor_version])
      } else {
        if (stale || context.reveal_state !== 'REQUESTED' || context.reveal_requested_by === user.id || !context.reveal_requested_by) {
          throw new ConflictException('Ответить может получатель активного запроса')
        }
        if (action === 'ACCEPT') {
          if (!context.owner_current || !context.visitor_current) throw new ConflictException('Обоим участникам нужен привязанный Telegram')
          await client.query(`
            UPDATE chats SET reveal_state = 'ACCEPTED' WHERE id = $1
          `, [id])
          await client.query(`
            INSERT INTO chat_contact_exchanges (chat_id, requested_by, accepted_by) VALUES ($1, $2, $3)
          `, [id, context.reveal_requested_by, user.id])
        } else {
          await client.query(`
            UPDATE chats SET reveal_state = 'DECLINED', owner_telegram_version = NULL,
              visitor_telegram_version = NULL WHERE id = $1
          `, [id])
        }
      }
      return this.show(client, user.id, id)
    })
  }

  async review(user: SessionUser, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    const rating = integer(body.rating, 'Оценка', 1, 5)
    const comment = str(body.comment ?? '', 'Отзыв', 0, 1000)
    if (outsideContact(comment)) throw new BadRequestException('Уберите контакты из отзыва')
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      const subject = this.partner(context, user.id)
      const { rows: participants } = await client.query<{ total: number }>(`
        SELECT count(DISTINCT sender_id)::int AS total FROM chat_messages WHERE chat_id = $1 AND sender_id IN ($2, $3)
      `, [id, user.id, subject])
      if (participants[0].total < 2) throw new ConflictException('Отзыв доступен после обмена сообщениями')
      const { rows } = await client.query(`
        INSERT INTO reviews (chat_id, author_id, subject_id, rating, comment)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chat_id, author_id) DO NOTHING
        RETURNING id, rating, comment, status, created_at AS "createdAt"
      `, [id, user.id, subject, rating, comment])
      if (!rows[0]) throw new ConflictException('Вы уже оставили отзыв в этом чате')
      return rows[0]
    })
  }

  async report(user: SessionUser, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    const reason = oneOf(body.reason, ['FRAUD', 'ABUSE', 'OTHER'], 'Причина')
    const scope = oneOf(body.scope ?? 'ON_PLATFORM', ['ON_PLATFORM', 'VERIFIED_TELEGRAM'], 'Источник')
    const details = str(body.details, 'Опишите проблему', 10, 4000)
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      if (scope === 'VERIFIED_TELEGRAM') {
        const evidence = await client.query('SELECT 1 FROM chat_contact_exchanges WHERE chat_id = $1 LIMIT 1', [id])
        if (!evidence.rows[0]) throw new BadRequestException('Мы принимаем жалобы по Telegram, раскрытому в этом чате')
      }
      const { rows } = await client.query(`
        INSERT INTO reports (chat_id, reporter_id, subject_id, reason, scope, details)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chat_id, reporter_id) DO NOTHING
        RETURNING id, reason, scope, details, status, created_at AS "createdAt"
      `, [id, user.id, this.partner(context, user.id), reason, scope, details])
      if (!rows[0]) throw new ConflictException('В этом чате уже есть ваша жалоба')
      return rows[0]
    })
  }

  private async show(db: Queryable, userId: string, id: string) {
    const { rows } = await db.query(`
      SELECT ${chatColumns} ${chatJoins} WHERE ${memberWhere} AND c.id = $2
    `, [userId, id])
    if (!rows[0]) throw new NotFoundException('Чат не найден')
    return rows[0]
  }

  private async context(db: Queryable, userId: string, id: string, lock = false): Promise<ChatContext> {
    const { rows } = await db.query<ChatContext>(`
      SELECT c.id, c.owner_id, c.visitor_id, c.reveal_state, c.reveal_requested_by, c.owner_telegram_version,
        c.visitor_telegram_version, owner.telegram_version AS owner_version, visitor.telegram_version AS visitor_version,
        owner.telegram AS owner_current, visitor.telegram AS visitor_current,
        (${chatActive}) AS active
      ${chatJoins} WHERE ${memberWhere} AND c.id = $2
      ${lock ? 'FOR UPDATE OF c FOR SHARE OF owner, visitor, l' : ''}
    `, [userId, id])
    if (!rows[0]) throw new NotFoundException('Чат не найден')
    return rows[0]
  }

  private partner(chat: ChatContext, userId: string) {
    return chat.owner_id === userId ? chat.visitor_id : chat.owner_id
  }

  private consentMatches(chat: ChatContext) {
    return chat.owner_telegram_version === chat.owner_version && chat.visitor_telegram_version === chat.visitor_version
  }

  private assertActive(chat: ChatContext) {
    if (!chat.active) throw new ForbiddenException('Чат доступен только для просмотра')
  }
}
