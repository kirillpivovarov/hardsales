import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import { isStaffRole, type Role, type StaffSession } from '../auth/auth.types'
import { isPublicProfileText } from '../contact'
import { ContactGuardService, hiddenContactMessage } from '../contact-guard/contact-guard.service'
import { DatabaseService, type Queryable } from '../database/database.service'
import { assertCompanyAlias } from '../exchange/disclosure-names'
import { representationEnabled } from '../exchange/representation.rules'
import { TrustService } from '../exchange/trust.service'
import { CatalogService } from './catalog.service'
import { ListingMediaService, type ListingImageUpload } from './listing-media.service'
import {
  accountStatuses, accountTypes, boolean, country, escapedSearch, integer, listingStatuses, localeCode,
  object, oneOf, pageParams, Parameters, reportStatuses, reviewStatuses, slug, str, telegram, uuid,
} from './market.inputs'
import { actualityRequestedSql, categoryColumns } from './market.queries'

const participantRoles = ['BUYER', 'SELLER'] as const
const userRoles = [...participantRoles, 'ADMIN', 'MODERATOR'] as const
const auditRoles = ['ADMIN', 'MODERATOR', 'AGENT', 'BUYER', 'SELLER'] as const
const participantRow = "u.role IN ('BUYER', 'SELLER')"

function userColumns(restrictStaffContacts = false) {
  const contact = (field: 'email' | 'telegram') => restrictStaffContacts
    ? `CASE WHEN ${participantRow} THEN u.${field} END AS ${field}` : `u.${field}`
  return `
    u.id, u.username, u.display_name AS "displayName", ${contact('email')}, u.role, u.participant_type AS "participantType",
    u.company_name AS "companyName", u.city, u.country, ${contact('telegram')}, u.status,
    CASE WHEN ${participantRow} AND ${representationEnabled} THEN
      CASE WHEN u.company_email_confirmed_at IS NULL THEN 'UNVERIFIED' ELSE u.company_email_domain_kind END
    END AS "companyEmailStatus",
    (u.email_verified_at IS NOT NULL) AS "emailVerified", u.created_at AS "createdAt", u.updated_at AS "updatedAt"
  `
}

const auditColumns = `
  a.id::float8 AS id, a.actor, a.actor_user_id AS "actorUserId", a.actor_role AS "actorRole",
  a.entity, a.entity_id AS "entityId", a.action, a.reason, a.before_data AS before, a.after_data AS after,
  a.created_at AS "createdAt"
`
const reviewColumns = `
  r.id, r.chat_id AS "chatId", r.rating, r.comment, r.status, r.created_at AS "createdAt",
  jsonb_build_object('id', a.id, 'nickname', a.display_name) AS author,
  jsonb_build_object('id', s.id, 'nickname', s.display_name) AS subject
`
const reviewJoins = 'FROM reviews r JOIN users a ON a.id = r.author_id JOIN users s ON s.id = r.subject_id'
const reportColumns = `
  r.id, r.chat_id AS "chatId", r.listing_id AS "listingId", r.reason, r.scope, r.details, r.status, r.resolution, r.created_at AS "createdAt",
  CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id', a.id, 'nickname', a.display_name) END AS reporter,
  jsonb_build_object('id', s.id, 'nickname', s.display_name) AS subject
`
const reportJoins = 'FROM reports r LEFT JOIN users a ON a.id = r.reporter_id JOIN users s ON s.id = r.subject_id'

const statusTables = {
  users: { choices: accountStatuses, table: 'users' },
  listings: { choices: listingStatuses.filter(status => status !== 'HIDDEN'), table: 'listings' },
  reviews: { choices: reviewStatuses, table: 'reviews' },
  reports: { choices: reportStatuses, table: 'reports' },
} as const
type Entity = keyof typeof statusTables
type AuditData = Record<string, unknown> | null
type HumanAuditActor = Pick<StaffSession, 'id' | 'username' | 'role'>
type StaffActor = HumanAuditActor & Pick<StaffSession, 'sessionHash'>
type AuditActor = HumanAuditActor | 'agent:moderation'
type StatusAudit = { entity: string; entity_id: string; reason: string; action: string; after_data: { status: string } }
const editableUserFields = new Set(['displayName', 'city', 'country', 'telegram', 'participantType', 'companyName'])

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService, private readonly catalog: CatalogService, private readonly media: ListingMediaService,
    private readonly trust: TrustService,
    private readonly contactGuard: ContactGuardService,
  ) {}

  users(actor: StaffActor, query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    const restrictStaffContacts = actor.role === 'MODERATOR'
    if (query.status) filters.push(`u.status = ${params.add(oneOf(query.status, accountStatuses, 'Статус'))}`)
    if (query.role) filters.push(`u.role = ${params.add(oneOf(query.role, userRoles, 'Роль'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      const searchEmail = restrictStaffContacts ? `(${participantRow} AND u.email ILIKE ${q})` : `u.email ILIKE ${q}`
      filters.push(`(u.username ILIKE ${q} OR u.display_name ILIKE ${q} OR ${searchEmail} OR u.company_name ILIKE ${q})`)
    }
    return this.staffTransaction(actor, async (client, currentActor) => {
      const result = await this.listPage(userColumns(restrictStaffContacts), 'FROM users u', filters, params,
        query, 'u.created_at DESC, u.id', client)
      if (result.items.length) {
        await this.audit(client, currentActor, 'users', 'list', 'profiles-listed', null, null,
          { page: result.page, count: result.items.length })
      }
      return result
    })
  }

  async user(actor: StaffActor, idInput: string) {
    const id = uuid(idInput)
    return this.staffTransaction(actor, async (client, currentActor) => {
      const { rows } = await client.query(`SELECT ${userColumns(actor.role === 'MODERATOR')} FROM users u WHERE id = $1`, [id])
      const user = rows[0]
      if (!user) throw new NotFoundException('Пользователь не найден')
      if (user.email || user.telegram) await this.audit(client, currentActor, 'users', id, 'profile-viewed', null, null, null)
      return user
    })
  }

  async editUser(actor: StaffActor, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    if (Object.keys(body).some(key => !editableUserFields.has(key))) {
      throw new BadRequestException('Запрос содержит поля, недоступные для редактирования профиля')
    }
    await this.contactGuard.assertFields(undefined, 'PROFILE', { displayName: body.displayName, city: body.city })
    const updated = await this.staffTransaction(actor, async (client, currentActor) => {
      if (isStaffRole(await this.userRole(client, id))) {
        await this.audit(client, currentActor, 'users', id, 'edit-denied', 'Профиль сотрудника', null, null)
        return null
      }
      const { rows } = await client.query(`SELECT ${userColumns()} FROM users u WHERE id = $1 FOR UPDATE`, [id])
      const before = rows[0]
      if (!before) throw new NotFoundException('Пользователь не найден')
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
      if (displayName !== before.displayName || companyName !== before.companyName) {
        await assertCompanyAlias(client, companyName, before.username, displayName)
      }
      const result = await client.query(`
          UPDATE users AS u SET display_name = $2, city = $3, country = $4, telegram = $5,
            participant_type = $6, company_name = $7, updated_at = now()
          WHERE id = $1 RETURNING ${userColumns()}
        `, [id, displayName, city, nation, handle, participantType, companyName])
      const after = result.rows[0]
      // The audit records that a private contact changed without copying the contact.
      await this.audit(client, currentActor, 'users', id, 'edited', null, {
        displayName: before.displayName, city: before.city, country: before.country,
        participantType: before.participantType, companyName: before.companyName,
      }, {
        displayName, city, country: nation, participantType, companyName, telegramChanged: before.telegram?.toLowerCase() !== handle,
      })
      return after
    })
    if (!updated) throw new ForbiddenException('Данные сотрудника доступны в его личном профиле')
    return updated
  }

  async editListing(actor: StaffActor, idInput: string, body: unknown, uploads?: ListingImageUpload[]) {
    const id = uuid(idInput)
    const raw = object(body)
    const images = await this.media.prepare(raw.imageOrder, uploads)
    return this.staffTransaction(actor, async (client, currentActor) => {
      await this.catalog.lockListingOwner(client, id)
      const before = await this.catalog.lock(client, id)
      const after = await this.catalog.update(client, before, raw, images)
      await this.audit(client, currentActor, 'listings', id, 'edited', null, before, after)
      return after
    })
  }

  reviews(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.subjectId) filters.push(`r.subject_id = ${params.add(uuid(query.subjectId))}`)
    if (query.status) filters.push(`r.status = ${params.add(oneOf(query.status, reviewStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(r.comment ILIKE ${q} OR a.display_name ILIKE ${q} OR s.display_name ILIKE ${q})`)
    }
    return this.listPage(reviewColumns, reviewJoins, filters, params, query, 'r.created_at DESC, r.id')
  }

  async review(idInput: string) {
    const { rows } = await this.db.query(`SELECT ${reviewColumns} ${reviewJoins} WHERE r.id = $1`, [uuid(idInput)])
    if (!rows[0]) throw new NotFoundException('Отзыв не найден')
    return rows[0]
  }

  reports(actor: StaffActor, query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.subjectId) filters.push(`r.subject_id = ${params.add(uuid(query.subjectId))}`)
    if (query.status) filters.push(`r.status = ${params.add(oneOf(query.status, reportStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(r.details ILIKE ${q} OR a.display_name ILIKE ${q} OR s.display_name ILIKE ${q})`)
    }
    return this.staffTransaction(actor, async (client, currentActor) => {
      const result = await this.listPage(reportColumns, reportJoins, filters, params, query, 'r.created_at DESC, r.id', client)
      if (result.items.length) {
        await this.audit(client, currentActor, 'reports', 'list', 'reports-listed', null, null,
          { page: result.page, count: result.items.length })
      }
      return result
    })
  }

  async report(actor: StaffActor, idInput: string) {
    const id = uuid(idInput)
    return this.staffTransaction(actor, async (client, currentActor) => {
      const { rows } = await client.query(`SELECT ${reportColumns} ${reportJoins} WHERE r.id = $1`, [id])
      if (!rows[0]) throw new NotFoundException('Жалоба не найдена')
      await this.audit(client, currentActor, 'reports', id, 'report-viewed', null, null, null)
      return rows[0]
    })
  }

  async evidence(actor: StaffActor, idInput: string, query: Record<string, unknown>) {
    const id = uuid(idInput)
    const { page, limit, offset } = pageParams(query, 50)
    return this.staffTransaction(actor, async (client, currentActor) => {
      const { rows } = await client.query<{ chat_id: string | null }>('SELECT chat_id FROM reports WHERE id = $1', [id])
      if (!rows[0]) throw new NotFoundException('Жалоба не найдена')
      const chatId = rows[0].chat_id
      const hide = actor.role !== 'ADMIN' && await this.contactGuard.enabled(client)
      const messages = await client.query(`
        SELECT m.id::float8 AS id, CASE WHEN $4 AND m.hidden_for_peer THEN $5 ELSE m.body END AS body,
          m.sender_id AS "senderId", u.display_name AS "nickname",
          m.contact_warning AS "contactWarning", m.created_at AS "createdAt"
        FROM chat_messages m JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = $1 ORDER BY m.id DESC LIMIT $2 OFFSET $3
      `, [chatId, limit, offset, hide, hiddenContactMessage])
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM chat_messages WHERE chat_id = $1', [chatId])
      await this.audit(client, currentActor, 'reports', id, 'evidence-viewed', null, null, { page })
      return { items: messages.rows, total: count.rows[0].total, page, limit }
    })
  }

  async status(actor: StaffActor | 'agent:moderation', entity: Entity, idInput: string, raw: unknown, idempotency?: string) {
    const id = uuid(idInput)
    const body = object(raw)
    if (Object.keys(body).some(key => key !== 'status' && key !== 'reason')) {
      throw new BadRequestException('Для смены статуса укажите статус и причину')
    }
    const { choices, table } = statusTables[entity]
    const status = oneOf(body.status, idempotency ? accountStatuses : choices, 'Статус')
    const reason = str(body.reason, 'Причина', 3, 500)
    const result = await this.db.transaction(async client => {
      const currentActor = actor === 'agent:moderation' ? actor : await this.lockStaff(client, actor)
      if (currentActor === 'agent:moderation' && idempotency) {
        await client.query('SELECT pg_advisory_xact_lock(32913, hashtext($1))', [idempotency])
        const previous = await client.query<StatusAudit>(`
          SELECT entity, entity_id, reason, action, after_data FROM moderation_audit WHERE actor = $1 AND idempotency_key = $2
        `, [currentActor, idempotency])
        const recorded = previous.rows[0]
        if (recorded) {
          if (recorded.entity !== entity || recorded.entity_id !== id || recorded.reason !== reason || recorded.after_data.status !== status) {
            throw new ConflictException('Ключ уже использован для другой операции')
          }
          return { entity, id, status, changed: recorded.action === 'status-changed', replayed: true }
        }
      }
      if (entity === 'users') {
        const role = await this.userRole(client, id)
        const primary = currentActor !== 'agent:moderation' && currentActor.role === 'ADMIN'
        if (role === 'ADMIN' || (role === 'MODERATOR' && !primary)) {
          if (currentActor !== 'agent:moderation') {
            await this.audit(client, currentActor, entity, id, 'status-denied', reason, null,
              { requestedStatus: status, outcome: 'protected-staff' })
          }
          return { error: new ForbiddenException('Недостаточно прав для изменения статуса сотрудника') }
        }
      }
      const listingOwner = entity === 'listings' ? await this.catalog.lockListingOwner(client, id) : undefined
      const { rows } = await client.query(`
        SELECT status${entity === 'reports' ? ', resolution, reason AS report_reason, subject_id' :
          entity === 'listings' ? ', duplicate_of' : ''}
        FROM ${table} WHERE id = $1 FOR UPDATE
      `, [id])
      const before = rows[0]
      if (!before) throw new NotFoundException('Запись не найдена')
      if (entity === 'listings' && status === 'ACTIVE' && before.duplicate_of) {
        throw new ConflictException('Верните объявление через раздел «Дубли лотов».')
      }
      if (before.status === 'BANNED' && status !== 'BANNED') {
        if (currentActor !== 'agent:moderation') {
          await this.audit(client, currentActor, entity, id, 'status-denied', reason, { status: before.status },
            { requestedStatus: status, outcome: 'permanent-ban' })
        }
        return { error: new ConflictException('Бессрочная блокировка не отменяется') }
      }
      if (idempotency && before.status === 'ARCHIVED' && status !== 'BANNED') {
        throw new ConflictException('Агент может только заблокировать архивное объявление')
      }
      const changed = before.status !== status || (entity === 'reports' && before.resolution !== reason)
      if (changed) {
        if (entity === 'listings' && status === 'ACTIVE') {
          const listing = await this.catalog.show(client, id)
          if (currentActor === 'agent:moderation' && listing.spotCheckHold) {
            throw new ForbiddenException('Проверку может закрыть только сотрудник площадки')
          }
          await this.catalog.assertRepublishable(client, listing)
        }
        const extra = {
          reports: ', resolution = $3',
          users: ', updated_at = now(), credential_version = credential_version + 1',
          listings: `, updated_at = now(), expires_at = CASE
            WHEN $2 = 'ACTIVE' AND (status = 'ARCHIVED' OR expires_at IS NULL OR expires_at <= now())
            THEN greatest(now(), (SELECT starts_at FROM actuality_activation WHERE singleton AND ${actualityRequestedSql}))
              + lifetime_days * interval '1 day'
            ELSE expires_at END`,
          reviews: '',
        }[entity]
        const values = entity === 'reports' ? [id, status, reason] : [id, status]
        await client.query(`UPDATE ${table} SET status = $2${extra} WHERE id = $1`, values)
        if (entity === 'users') await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [id])
        if (listingOwner) await this.trust.refresh(client, listingOwner)
      }
      await this.audit(client, currentActor, entity, id, changed ? 'status-changed' : 'status-unchanged', reason,
        { status: before.status }, { status }, idempotency)
      if (changed && entity === 'users') await this.trust.refresh(client, id)
      if (entity === 'reports' && before.status !== status && before.report_reason === 'FRAUD') {
        await this.trust.refresh(client, before.subject_id)
      }
      return { entity, id, status, changed, replayed: false }
    })
    if (result.error) throw result.error
    return result
  }

  async saveCategory(actor: StaffActor, idInput: string | null, raw: unknown) {
    const id = idInput ? uuid(idInput) : null
    const body = object(raw)
    return this.staffTransaction(actor, async (client, currentActor) => {
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
      await this.audit(client, currentActor, 'categories', after.id, id ? 'edited' : 'created', null, before, after)
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

  async saveLocale(actor: StaffActor, codeInput: string, raw: unknown) {
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
    return this.staffTransaction(actor, async (client, currentActor) => {
      await client.query('SELECT pg_advisory_xact_lock(32914, hashtext($1))', [code])
      const { rows: previous } = await client.query('SELECT code, name, active, messages FROM site_locales WHERE code = $1', [code])
      const { rows } = await client.query(`
        INSERT INTO site_locales (code, name, active, messages) VALUES ($1, $2, $3, $4)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
          messages = EXCLUDED.messages, updated_at = now()
        RETURNING code, name, active, messages, updated_at AS "updatedAt"
      `, [code, name, active, JSON.stringify(messages)])
      await this.audit(client, currentActor, 'locales', code, previous[0] ? 'edited' : 'created', null,
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

  async saveContent(actor: StaffActor, keyInput: string, raw: unknown) {
    const key = slug(keyInput, 'Код страницы')
    const body = object(raw)
    const active = boolean(body.active ?? true, 'Публикация')
    const translations = this.localized(body.translations, true, value => ({
      title: str(value.title, 'Заголовок', 2, 140),
      body: str(value.body, 'Текст', 1, 20000),
    }))
    return this.staffTransaction(actor, async (client, currentActor) => {
      await client.query('SELECT pg_advisory_xact_lock(32915, hashtext($1))', [key])
      const { rows: previous } = await client.query('SELECT key, translations, active FROM site_content WHERE key = $1', [key])
      const { rows } = await client.query(`
        INSERT INTO site_content (key, translations, active) VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET translations = EXCLUDED.translations,
          active = EXCLUDED.active, updated_at = now()
        RETURNING key, translations, active, updated_at AS "updatedAt"
      `, [key, JSON.stringify(translations), active])
      await this.audit(client, currentActor, 'content', key, previous[0] ? 'edited' : 'created', null,
        previous[0] ?? null, rows[0])
      return rows[0]
    })
  }

  history(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    if (query.actorRole) filters.push(`a.actor_role = ${params.add(oneOf(query.actorRole, auditRoles, 'Роль'))}`)
    if (query.entityId) filters.push(`a.entity_id = ${params.add(str(query.entityId, 'Идентификатор', 1, 100))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(a.actor ILIKE ${q} OR a.entity ILIKE ${q} OR a.entity_id ILIKE ${q} OR a.reason ILIKE ${q})`)
    }
    return this.listPage(auditColumns, 'FROM moderation_audit a', filters, params, query, 'a.id DESC')
  }

  private async staffTransaction<T>(actor: StaffActor, operation: (client: PoolClient, current: HumanAuditActor) => Promise<T>) {
    return this.db.transaction(async client => operation(client, await this.lockStaff(client, actor)))
  }

  private async lockStaff(client: PoolClient, actor: StaffActor): Promise<HumanAuditActor> {
    // Use the same user-then-session lock order as freeze and credential rotation.
    const { rows } = await client.query<HumanAuditActor>(`
      SELECT id, role, username FROM users WHERE id = $1 AND role IN ('ADMIN', 'MODERATOR')
        AND status = 'ACTIVE' AND email_verified_at IS NOT NULL AND NOT must_change_password FOR SHARE
    `, [actor.id])
    if (!rows[0] || rows[0].role !== actor.role) throw new ForbiddenException('Доступ сотрудника ограничен')
    const session = await client.query(`
      SELECT 1 FROM auth_sessions WHERE user_id = $1 AND token_hash = $2
        AND expires_at > clock_timestamp() FOR SHARE
    `, [actor.id, actor.sessionHash])
    if (!session.rows[0]) throw new ForbiddenException('Сеанс сотрудника завершён. Войдите снова.')
    return rows[0]
  }

  private async userRole(client: PoolClient, id: string) {
    // Role is immutable. Check it before taking an exclusive lock on the target row.
    const { rows } = await client.query<{ role: Role }>('SELECT role FROM users WHERE id = $1', [id])
    if (!rows[0]) throw new NotFoundException('Пользователь не найден')
    return rows[0].role
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

  private async audit(client: PoolClient, actor: AuditActor, entity: string, id: string, action: string,
    reason: string | null, before: AuditData, after: AuditData, idempotency?: string) {
    const username = actor === 'agent:moderation' ? actor : actor.username
    const userId = actor === 'agent:moderation' ? null : actor.id
    const role = actor === 'agent:moderation' ? 'AGENT' : actor.role
    await client.query(`
      INSERT INTO moderation_audit (actor, actor_user_id, actor_role, entity, entity_id, action, reason,
        before_data, after_data, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [username, userId, role, entity, id, action, reason, before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null, idempotency ?? null])
  }

  private async listPage(select: string, from: string, filters: string[], params: Parameters,
    query: Record<string, unknown>, order: string, db: Queryable = this.db) {
    const { page, limit, offset } = pageParams(query)
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countValues = [...params.values]
    const limitParam = params.add(limit)
    const offsetParam = params.add(offset)
    const items = await db.query(`SELECT ${select} ${from} ${where} ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`, params.values)
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total ${from} ${where}`, countValues)
    return { items: items.rows, total: count.rows[0].total, page, limit }
  }

  private unique(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
  }
}
