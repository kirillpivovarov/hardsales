import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import { isPublicProfileText } from '../contact'
import { DatabaseService } from '../database/database.service'
import { CatalogService } from './catalog.service'
import { ListingMediaService, type ListingImageUpload } from './listing-media.service'
import {
  accountStatuses, accountTypes, boolean, country, escapedSearch, integer, listingStatuses, localeCode,
  object, oneOf, pageParams, Parameters, reportStatuses, reviewStatuses, slug, str, telegram, uuid,
} from './market.inputs'
import { categoryColumns } from './market.queries'

const userColumns = `
  u.id, u.username, u.display_name AS "displayName", u.email, u.role, u.participant_type AS "participantType",
  u.company_name AS "companyName", u.city, u.country, u.telegram, u.status,
  (u.email_verified_at IS NOT NULL) AS "emailVerified", u.created_at AS "createdAt", u.updated_at AS "updatedAt"
`
const auditColumns = `
  a.id::float8 AS id, a.actor, a.entity, a.entity_id AS "entityId", a.action, a.reason,
  a.before_data AS before, a.after_data AS after, a.created_at AS "createdAt"
`

const statusTables = {
  users: { choices: accountStatuses, table: 'users' },
  listings: { choices: listingStatuses, table: 'listings' },
  reviews: { choices: reviewStatuses, table: 'reviews' },
  reports: { choices: reportStatuses, table: 'reports' },
} as const
type Entity = keyof typeof statusTables
type AuditData = Record<string, unknown> | null
type StatusAudit = { entity: string; entity_id: string; reason: string; action: string; after_data: { status: string } }

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService, private readonly catalog: CatalogService, private readonly media: ListingMediaService,
  ) {}

  users(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.status) filters.push(`u.status = ${params.add(oneOf(query.status, accountStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(u.username ILIKE ${q} OR u.display_name ILIKE ${q} OR u.email ILIKE ${q} OR u.company_name ILIKE ${q})`)
    }
    return this.listPage(userColumns, 'FROM users u', filters, params, query, 'u.created_at DESC, u.id')
  }

  async editUser(actor: string, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    return this.db.transaction(async client => {
      const { rows } = await client.query(`SELECT ${userColumns} FROM users u WHERE id = $1 FOR UPDATE`, [id])
      const before = rows[0]
      if (!before) throw new NotFoundException('Пользователь не найден')
      if (before.role === 'ADMIN') throw new ForbiddenException('Данные администратора доступны в личном профиле')
      const next = { ...before, ...body }
      const displayName = str(next.displayName, 'Публичное имя', 2, 80)
      const city = str(next.city, 'Город', 2, 80)
      if (![displayName, city].every(isPublicProfileText)) {
        throw new BadRequestException('Уберите контакты и ссылки из публичного имени и города')
      }
      const nation = country(next.country, 'Страна')
      const handle = telegram(next.telegram)
      const participantType = oneOf(next.participantType, accountTypes, 'Тип участника')
      const companyName = participantType === 'COMPANY' ? str(next.companyName, 'Компания', 2, 120) : null
      const result = await client.query(`
          UPDATE users AS u SET display_name = $2, city = $3, country = $4, telegram = $5,
            participant_type = $6, company_name = $7, updated_at = now()
          WHERE id = $1 RETURNING ${userColumns}
        `, [id, displayName, city, nation, handle, participantType, companyName])
      const after = result.rows[0]
      // The audit records that a private contact changed without copying the contact.
      await this.audit(client, actor, 'users', id, 'edited', null, {
        displayName: before.displayName, city: before.city, country: before.country,
        participantType: before.participantType, companyName: before.companyName,
      }, {
        displayName, city, country: nation, participantType, companyName, telegramChanged: before.telegram !== handle,
      })
      return after
    })
  }

  async editListing(actor: string, idInput: string, body: unknown, uploads?: ListingImageUpload[]) {
    const id = uuid(idInput)
    const raw = object(body)
    const images = await this.media.prepare(raw.imageOrder, uploads)
    return this.db.transaction(async client => {
      const before = await this.catalog.lock(client, id)
      const after = await this.catalog.update(client, before, raw, images)
      await this.audit(client, actor, 'listings', id, 'edited', null, before, after)
      return after
    })
  }

  reviews(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.status) filters.push(`r.status = ${params.add(oneOf(query.status, reviewStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(r.comment ILIKE ${q} OR a.display_name ILIKE ${q} OR s.display_name ILIKE ${q})`)
    }
    return this.listPage(`
      r.id, r.chat_id AS "chatId", r.rating, r.comment, r.status, r.created_at AS "createdAt",
      jsonb_build_object('id', a.id, 'nickname', a.display_name) AS author,
      jsonb_build_object('id', s.id, 'nickname', s.display_name) AS subject
    `, `FROM reviews r JOIN users a ON a.id = r.author_id JOIN users s ON s.id = r.subject_id`,
    filters, params, query, 'r.created_at DESC, r.id')
  }

  reports(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.status) filters.push(`r.status = ${params.add(oneOf(query.status, reportStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(r.details ILIKE ${q} OR a.display_name ILIKE ${q} OR s.display_name ILIKE ${q})`)
    }
    return this.listPage(`
      r.id, r.chat_id AS "chatId", r.reason, r.scope, r.details, r.status, r.resolution, r.created_at AS "createdAt",
      jsonb_build_object('id', a.id, 'nickname', a.display_name) AS reporter,
      jsonb_build_object('id', s.id, 'nickname', s.display_name) AS subject
    `, `FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users s ON s.id = r.subject_id`,
    filters, params, query, 'r.created_at DESC, r.id')
  }

  async evidence(actor: string, idInput: string, query: Record<string, unknown>) {
    const id = uuid(idInput)
    const { page, limit, offset } = pageParams(query, 50)
    return this.db.transaction(async client => {
      const { rows } = await client.query<{ chat_id: string }>('SELECT chat_id FROM reports WHERE id = $1', [id])
      if (!rows[0]) throw new NotFoundException('Жалоба не найдена')
      const chatId = rows[0].chat_id
      const messages = await client.query(`
        SELECT m.id::float8 AS id, m.body, m.sender_id AS "senderId", u.display_name AS "nickname",
          m.contact_warning AS "contactWarning", m.created_at AS "createdAt"
        FROM chat_messages m JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = $1 ORDER BY m.id DESC LIMIT $2 OFFSET $3
      `, [chatId, limit, offset])
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM chat_messages WHERE chat_id = $1', [chatId])
      await this.audit(client, actor, 'reports', id, 'evidence-viewed', null, null, { page })
      return { items: messages.rows, total: count.rows[0].total, page, limit }
    })
  }

  async status(actor: string, entity: Entity, idInput: string, raw: unknown, idempotency?: string) {
    const id = uuid(idInput)
    const body = object(raw)
    const { choices, table } = statusTables[entity]
    const status = oneOf(body.status, idempotency ? accountStatuses : choices, 'Статус')
    const reason = str(body.reason, 'Причина', 3, 500)
    return this.db.transaction(async client => {
      if (idempotency) {
        await client.query('SELECT pg_advisory_xact_lock(32913, hashtext($1))', [idempotency])
        const previous = await client.query<StatusAudit>(`
          SELECT entity, entity_id, reason, action, after_data FROM moderation_audit WHERE actor = $1 AND idempotency_key = $2
        `, [actor, idempotency])
        const recorded = previous.rows[0]
        if (recorded) {
          if (recorded.entity !== entity || recorded.entity_id !== id || recorded.reason !== reason || recorded.after_data.status !== status) {
            throw new ConflictException('Ключ уже использован для другой операции')
          }
          return { entity, id, status, changed: recorded.action === 'status-changed', replayed: true }
        }
      }
      const { rows } = await client.query(`
        SELECT status${entity === 'users' ? ', role' : ''}${entity === 'reports' ? ', resolution' : ''}
        FROM ${table} WHERE id = $1 FOR UPDATE
      `, [id])
      const before = rows[0]
      if (!before) throw new NotFoundException('Запись не найдена')
      if (before.role === 'ADMIN') throw new ForbiddenException('Администраторы не подлежат этой операции')
      if (before.status === 'BANNED' && status !== 'BANNED') throw new ConflictException('Бессрочная блокировка не отменяется')
      if (idempotency && before.status === 'ARCHIVED' && status !== 'BANNED') {
        throw new ConflictException('Агент может только заблокировать архивное объявление')
      }
      const changed = before.status !== status || (entity === 'reports' && before.resolution !== reason)
      if (changed) {
        if (entity === 'listings' && status === 'ACTIVE') {
          await this.catalog.assertRepublishable(client, await this.catalog.show(client, id))
        }
        const extra = {
          reports: ', resolution = $3',
          users: ', updated_at = now(), credential_version = credential_version + 1',
          listings: ', updated_at = now()',
          reviews: '',
        }[entity]
        const values = entity === 'reports' ? [id, status, reason] : [id, status]
        await client.query(`UPDATE ${table} SET status = $2${extra} WHERE id = $1`, values)
        if (entity === 'users') await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [id])
      }
      if (changed || idempotency) {
        await this.audit(client, actor, entity, id, changed ? 'status-changed' : 'status-unchanged', reason,
          { status: before.status }, { status }, idempotency)
      }
      return { entity, id, status, changed, replayed: false }
    })
  }

  async saveCategory(actor: string, idInput: string | null, raw: unknown) {
    const id = idInput ? uuid(idInput) : null
    const body = object(raw)
    return this.db.transaction(async client => {
      // Serializes reparenting to make concurrent category edits cycle-safe.
      await client.query('LOCK TABLE categories IN SHARE ROW EXCLUSIVE MODE')
      const before = id ? await this.getCategory(client, id) : null
      const next = { ...before, ...body }
      const categorySlug = slug(next.slug, 'Код категории')
      const name = str(next.name, 'Название', 2, 120)
      const shortName = str(next.shortName ?? name, 'Короткое название', 2, 120)
      const description = str(next.description ?? '', 'Описание', 0, 500)
      const icon = slug(next.icon ?? 'components', 'Значок')
      const parentId = next.parentId ? uuid(next.parentId, 'Родительская категория') : null
      if (parentId) {
        await this.getCategory(client, parentId)
        const { rows } = await client.query(`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_id FROM categories WHERE id = $1
            UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON a.parent_id = c.id
          ) SELECT id FROM ancestors WHERE id = $2
        `, [parentId, id])
        if (rows.length) throw new BadRequestException('Категория не может находиться в собственной ветке')
      }
      const active = boolean(next.active ?? true, 'Публикация')
      const sortOrder = integer(next.sortOrder ?? 100, 'Порядок', 0, 10000)
      const attributes = next.attributeKeys ?? []
      if (!Array.isArray(attributes) || attributes.length > 30) throw new BadRequestException('Можно указать до 30 характеристик')
      const keys = [...new Set(attributes.map(key => str(key, 'Характеристика', 1, 80)))]
      const translations = this.localized(next.translations ?? {}, false, value => ({
        name: str(value.name, 'Название', 2, 120),
        ...(value.shortName !== undefined ? { shortName: str(value.shortName, 'Короткое название', 2, 120) } : {}),
        ...(value.description !== undefined ? { description: str(value.description, 'Описание', 0, 500) } : {}),
      }))
      const values = [categorySlug, name, shortName, description, icon, parentId, active, sortOrder, keys, JSON.stringify(translations)]
      let resultId = id
      try {
        if (id) {
          await client.query(`
            UPDATE categories SET slug = $1, name = $2, short_name = $3, description = $4,
              icon = $5, parent_id = $6, active = $7, sort_order = $8, attribute_keys = $9, translations = $10
            WHERE id = $11
          `, [...values, id])
        } else {
          const { rows } = await client.query<{ id: string }>(`
            INSERT INTO categories (slug, name, short_name, description, icon, parent_id, active, sort_order, attribute_keys, translations)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
          `, values)
          resultId = rows[0].id
        }
      } catch (error) {
        if (this.unique(error)) throw new ConflictException('Код категории уже используется')
        throw error
      }
      const after = await this.getCategory(client, resultId!)
      await this.audit(client, actor, 'categories', after.id, id ? 'edited' : 'created', null, before, after)
      return after
    })
  }

  async locales(admin = false) {
    const { rows } = await this.db.query(`
      SELECT code, name, active, messages, updated_at AS "updatedAt"
      FROM site_locales WHERE $1 OR active ORDER BY (code = 'ru') DESC, code
    `, [admin])
    return rows
  }

  async saveLocale(actor: string, codeInput: string, raw: unknown) {
    const code = localeCode(codeInput)
    const body = object(raw)
    const name = str(body.name, 'Название языка', 2, 80)
    const active = boolean(body.active ?? false, 'Публикация')
    if (code === 'ru' && !active) throw new BadRequestException('Русский язык используется по умолчанию')
    const entries = Object.entries(object(body.messages ?? {}, 'Переводы'))
    if (entries.length > 2000) throw new BadRequestException('Можно сохранить до 2000 строк')
    const messages = Object.fromEntries(entries.map(([key, value]) => {
      if (!key.trim() || key.length > 1000 || /[\u0000-\u001f\u007f]/u.test(key) ||
          Object.hasOwn(Object.prototype, key) || key === 'prototype') {
        throw new BadRequestException('Некорректный ключ строки')
      }
      return [key, str(value, 'Перевод', 1, 2000)]
    }))
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(32914, hashtext($1))', [code])
      const { rows: previous } = await client.query('SELECT code, name, active, messages FROM site_locales WHERE code = $1', [code])
      const { rows } = await client.query(`
        INSERT INTO site_locales (code, name, active, messages) VALUES ($1, $2, $3, $4)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
          messages = EXCLUDED.messages, updated_at = now()
        RETURNING code, name, active, messages, updated_at AS "updatedAt"
      `, [code, name, active, JSON.stringify(messages)])
      await this.audit(client, actor, 'locales', code, previous[0] ? 'edited' : 'created', null,
        previous[0] ?? null, rows[0])
      return rows[0]
    })
  }

  async content(admin = false) {
    const { rows } = await this.db.query(`
      SELECT key, translations, active, updated_at AS "updatedAt"
      FROM site_content WHERE $1 OR active ORDER BY key
    `, [admin])
    return rows
  }

  async saveContent(actor: string, keyInput: string, raw: unknown) {
    const key = slug(keyInput, 'Код страницы')
    const body = object(raw)
    const active = boolean(body.active ?? true, 'Публикация')
    const translations = this.localized(body.translations, true, value => ({
      title: str(value.title, 'Заголовок', 2, 140),
      body: str(value.body, 'Текст', 1, 20000),
    }))
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(32915, hashtext($1))', [key])
      const { rows: previous } = await client.query('SELECT key, translations, active FROM site_content WHERE key = $1', [key])
      const { rows } = await client.query(`
        INSERT INTO site_content (key, translations, active) VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET translations = EXCLUDED.translations,
          active = EXCLUDED.active, updated_at = now()
        RETURNING key, translations, active, updated_at AS "updatedAt"
      `, [key, JSON.stringify(translations), active])
      await this.audit(client, actor, 'content', key, previous[0] ? 'edited' : 'created', null,
        previous[0] ?? null, rows[0])
      return rows[0]
    })
  }

  history(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(a.actor ILIKE ${q} OR a.entity ILIKE ${q} OR a.entity_id ILIKE ${q} OR a.reason ILIKE ${q})`)
    }
    return this.listPage(auditColumns, 'FROM moderation_audit a', filters, params, query, 'a.id DESC')
  }

  private async getCategory(client: PoolClient, id: string) {
    const { rows } = await client.query<{ id: string } & Record<string, unknown>>(`
      SELECT ${categoryColumns} FROM categories c WHERE c.id = $1
    `, [id])
    if (!rows[0]) throw new NotFoundException('Категория не найдена')
    return rows[0]
  }

  private localized<T>(input: unknown, requireRussian: boolean, parse: (entry: Record<string, unknown>) => T) {
    const entries = Object.entries(object(input, 'Переводы'))
    if (entries.length > 30) throw new BadRequestException('Можно сохранить до 30 переводов')
    const translations = Object.fromEntries(entries.map(([code, value]) => [localeCode(code), parse(object(value, 'Перевод'))]))
    if (requireRussian && !translations.ru) throw new BadRequestException('Укажите текст на русском')
    return translations
  }

  private async audit(client: PoolClient, actor: string, entity: string, id: string, action: string,
    reason: string | null, before: AuditData, after: AuditData, idempotency?: string) {
    await client.query(`
      INSERT INTO moderation_audit (actor, entity, entity_id, action, reason, before_data, after_data, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [actor, entity, id, action, reason, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, idempotency ?? null])
  }

  private async listPage(select: string, from: string, filters: string[], params: Parameters,
    query: Record<string, unknown>, order: string) {
    const { page, limit, offset } = pageParams(query)
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countValues = [...params.values]
    const limitParam = params.add(limit)
    const offsetParam = params.add(offset)
    const [items, count] = await Promise.all([
      this.db.query(`SELECT ${select} ${from} ${where} ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`, params.values),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total ${from} ${where}`, countValues),
    ])
    return { items: items.rows, total: count.rows[0].total, page, limit }
  }

  private unique(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
  }
}
