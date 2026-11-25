import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { SessionUser } from '../auth/auth.types'
import { DatabaseService, type Queryable } from '../database/database.service'
import {
  accountTypes, availability, boolean, conditions, counterparties, country, currencies, escapedSearch,
  kinds, listingInput, listingStatuses, object, oneOf, originScopes, pageParams, Parameters, paymentMethods,
  priceValue, slug, str, uuid, vatModes,
} from './market.inputs'
import {
  categoryColumns, listingColumns, listingEditableColumns, listingJoins, listingPublicWhere,
  visibleCategories,
} from './market.queries'

type ListingRow = Record<string, unknown> & {
  id: string
  ownerId: string
  kind: typeof kinds[number]
  categoryId: string
  status: typeof listingStatuses[number]
}

@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService) {}

  async categories(includeInactive = false) {
    const { rows } = await this.db.query(`
      ${visibleCategories}
      SELECT ${categoryColumns}, coalesce(t.sell_count, 0)::int AS "sellCount",
        coalesce(t.buy_count, 0)::int AS "buyCount",
        (coalesce(t.sell_count, 0) + coalesce(t.buy_count, 0))::int AS "listingCount"
      FROM categories c
      LEFT JOIN (
        SELECT l.category_id, count(*) FILTER (WHERE l.kind = 'SELL') AS sell_count,
          count(*) FILTER (WHERE l.kind = 'BUY') AS buy_count
        FROM listings l JOIN users u ON u.id = l.owner_id WHERE ${listingPublicWhere}
        GROUP BY l.category_id
      ) t ON t.category_id = c.id
      WHERE $1 OR c.id IN (SELECT id FROM available_categories)
      ORDER BY c.sort_order, c.name, c.id
    `, [includeInactive])
    return rows
  }

  async browse(query: Record<string, unknown>, user: SessionUser | null) {
    const paging = pageParams(query, 12)
    if (!user || !user.emailVerified || user.status !== 'ACTIVE' || user.mustChangePassword) {
      return { items: [], total: 0, page: paging.page, limit: paging.limit, locked: true }
    }
    const allowed = user.role === 'ADMIN' ? null : this.oppositeKind(user)
    const requestedKind = query.kind ? oneOf(query.kind, kinds, 'Вид объявления') : null
    if (allowed && requestedKind && requestedKind !== allowed) {
      return { items: [], total: 0, page: paging.page, limit: paging.limit, locked: false }
    }
    const params = new Parameters()
    const filters = [listingPublicWhere]
    if (allowed || requestedKind) filters.push(`l.kind = ${params.add(allowed || requestedKind)}`)
    if (query.category) {
      const selected = params.add(slug(query.category, 'Категория'))
      filters.push(`l.category_id IN (
        WITH RECURSIVE branch AS (
          SELECT id FROM available_categories WHERE slug = ${selected}
          UNION ALL
          SELECT c.id FROM available_categories c JOIN branch b ON b.id = c.parent_id
        )
        SELECT id FROM branch
      )`)
    }
    if (query.q) {
      const terms = [...new Set(str(query.q, 'Поиск', 0, 200).split(/\s+/u).filter(Boolean))].slice(0, 20)
      for (const term of terms) {
        const q = params.add(escapedSearch(term))
        filters.push(`(l.title ILIKE ${q} OR l.description ILIKE ${q} OR c.name ILIKE ${q} OR
          c.short_name ILIKE ${q} OR c.translations::text ILIKE ${q} OR l.specs::text ILIKE ${q} OR
          l.stock_city ILIKE ${q} OR u.city ILIKE ${q})`)
      }
    }
    const selections = [
      ['ownerType', 'u.participant_type', accountTypes, 'Тип участника'],
      ['availability', 'l.availability', availability, 'Наличие'],
      ['originScope', 'l.origin_scope', originScopes, 'География поставки'],
      ['priceMode', 'l.price_mode', ['FIXED', 'NEGOTIABLE'], 'Тип цены'],
      ['vat', 'l.vat', vatModes, 'НДС'],
      ['counterparty', 'l.counterparty', counterparties, 'Тип контрагента'],
    ] as const
    for (const [key, field, valid, label] of selections) {
      if (query[key]) filters.push(`${field} = ${params.add(oneOf(query[key], valid, label))}`)
    }
    if (query.condition) {
      const condition = oneOf(query.condition, conditions, 'Состояние')
      const matching = `l.condition = ${params.add(condition)}`
      const acceptsAny = condition !== 'ANY' && (allowed || requestedKind) === 'BUY'
      filters.push(acceptsAny ? `(${matching} OR l.condition = 'ANY')` : matching)
    }
    const countries = [
      ['country', 'l.origin_country', 'Страна отгрузки'],
      ['originCountry', 'l.origin_country', 'Страна отгрузки'],
      ['destinationCountry', 'l.destination_country', 'Страна доставки'],
      ['ownerCountry', 'u.country', 'Страна участника'],
    ] as const
    for (const [key, field, label] of countries) {
      if (query[key]) filters.push(`${field} = ${params.add(country(query[key], label))}`)
    }
    if (query.city) {
      const city = params.add(escapedSearch(query.city))
      filters.push(`(u.city ILIKE ${city} OR l.stock_city ILIKE ${city})`)
    }
    if (query.paymentMethod) {
      filters.push(`${params.add(oneOf(query.paymentMethod, paymentMethods, 'Способ оплаты'))} = ANY(l.payment_methods)`)
    }
    if (query.deliveryIncluded !== undefined && query.deliveryIncluded !== '') {
      filters.push(`l.delivery_included = ${params.add(boolean(query.deliveryIncluded, 'Доставка'))}`)
    }
    if (query.customsIncluded !== undefined && query.customsIncluded !== '') {
      filters.push(`l.customs_included = ${params.add(boolean(query.customsIncluded, 'Таможенные расходы'))}`)
    }
    const lower = query.priceMin ? priceValue(query.priceMin, 'Цена от', 0) : null
    const upper = query.priceMax ? priceValue(query.priceMax, 'Цена до', 0) : null
    if (lower !== null && upper !== null && lower > upper) throw new BadRequestException('Укажите корректный диапазон цен')
    const currency = query.currency ? oneOf(query.currency, currencies, 'Валюта') : (lower !== null || upper !== null) ? 'RUB' : null
    if (currency) filters.push(`l.currency = ${params.add(currency)}`)
    if (lower !== null) filters.push(`l.price >= ${params.add(lower)}`)
    if (upper !== null) filters.push(`l.price <= ${params.add(upper)}`)
    const sort = query.sort ? oneOf(query.sort, ['newest', 'price-asc', 'price-desc'], 'Сортировка') : 'newest'
    const orders = {
      newest: 'l.created_at DESC, l.id',
      'price-asc': 'l.currency, l.price ASC NULLS LAST, l.created_at DESC, l.id',
      'price-desc': 'l.currency, l.price DESC NULLS LAST, l.created_at DESC, l.id',
    }
    return {
      ...await this.listPage(this.db, filters, params, paging, orders[sort], visibleCategories),
      locked: false,
    }
  }

  async mine(user: SessionUser, query: Record<string, unknown>) {
    const params = new Parameters()
    const filters = [`l.owner_id = ${params.add(user.id)}`]
    this.managementFilters(query, params, filters)
    return this.listPage(this.db, filters, params, pageParams(query), 'l.created_at DESC, l.id')
  }

  async administrativeListings(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    this.managementFilters(query, params, filters)
    if (query.kind) filters.push(`l.kind = ${params.add(oneOf(query.kind, kinds, 'Вид объявления'))}`)
    return this.listPage(this.db, filters, params, pageParams(query), 'l.created_at DESC, l.id')
  }

  async detail(user: SessionUser, idInput: string) {
    const id = uuid(idInput)
    const otherKind = user.role === 'ADMIN' ? null : this.oppositeKind(user)
    const result = await this.db.query<ListingRow>(`
      ${visibleCategories}
      SELECT ${listingColumns} ${listingJoins}
      WHERE l.id = $1 AND ($2 OR l.owner_id = $3 OR (l.kind = $4 AND ${listingPublicWhere}))
    `, [id, user.role === 'ADMIN', user.id, otherKind])
    return this.found(result.rows[0])
  }

  async show(db: Queryable, id: string) {
    const { rows } = await db.query<ListingRow>(`SELECT ${listingColumns} ${listingJoins} WHERE l.id = $1`, [id])
    return this.found(rows[0])
  }

  async create(user: SessionUser, body: unknown) {
    if (user.role === 'ADMIN') throw new ForbiddenException('Администратор не публикует объявления')
    const kind = user.role === 'SELLER' ? 'SELL' : 'BUY'
    const raw = object(body)
    if (raw.kind && raw.kind !== kind) throw new ForbiddenException('Вид объявления зависит от роли')
    const values = listingInput(raw, {}, kind)
    return this.db.transaction(async client => {
      await this.categoryReady(client, values[0] as string)
      const markers = listingEditableColumns.map((_, index) => `$${index + 3}`).join(', ')
      const { rows } = await client.query<{ id: string }>(`
        INSERT INTO listings (owner_id, kind, ${listingEditableColumns.join(', ')})
        SELECT $1, $2, ${markers} FROM users WHERE id = $1 AND
          status = 'ACTIVE' AND email_verified_at IS NOT NULL FOR SHARE
        RETURNING id
      `, [user.id, kind, ...values])
      if (!rows[0]) throw new ForbiddenException('Профиль недоступен')
      return this.show(client, rows[0].id)
    })
  }

  async change(user: SessionUser, idInput: string, body: unknown) {
    const id = uuid(idInput)
    return this.db.transaction(async client => {
      const existing = await this.lock(client, id)
      this.assertOwnership(existing, user)
      await this.activeUser(client, user.id)
      return this.update(client, existing, body)
    })
  }

  async update(client: PoolClient, existing: ListingRow, body: unknown) {
    const raw = object(body)
    if (raw.kind && raw.kind !== existing.kind) throw new BadRequestException('Вид объявления нельзя изменить')
    const values = listingInput(raw, existing, existing.kind)
    if (values[0] !== existing.categoryId) await this.categoryReady(client, values[0] as string)
    const assignments = listingEditableColumns.map((name, index) => `${name} = $${index + 2}`).join(', ')
    await client.query(`UPDATE listings SET ${assignments}, updated_at = now() WHERE id = $1`, [existing.id, ...values])
    return this.show(client, existing.id)
  }

  async archive(user: SessionUser, idInput: string, restore = false) {
    const id = uuid(idInput)
    return this.db.transaction(async client => {
      const existing = await this.lock(client, id)
      this.assertOwnership(existing, user)
      await this.activeUser(client, user.id)
      const desired = restore ? 'ACTIVE' : 'ARCHIVED'
      if (restore) await this.assertRepublishable(client, existing)
      if (existing.status === desired) return existing
      await client.query('UPDATE listings SET status = $2, updated_at = now() WHERE id = $1', [id, desired])
      return this.show(client, id)
    })
  }

  async assertRepublishable(client: PoolClient, existing: ListingRow) {
    await this.categoryReady(client, existing.categoryId)
    if (typeof existing.deliveryBy === 'string' && existing.deliveryBy < new Date().toISOString().slice(0, 10)) {
      throw new BadRequestException('Перед публикацией обновите срок поставки')
    }
  }

  async lock(client: PoolClient, id: string) {
    const result = await client.query('SELECT id FROM listings WHERE id = $1 FOR UPDATE', [id])
    if (!result.rows[0]) throw new NotFoundException('Объявление не найдено')
    return this.show(client, id)
  }

  private found(row?: ListingRow): ListingRow {
    if (!row) throw new NotFoundException('Объявление не найдено')
    return row
  }

  private oppositeKind(user: SessionUser): typeof kinds[number] {
    return user.role === 'SELLER' ? 'BUY' : 'SELL'
  }

  private assertOwnership(existing: ListingRow, user: SessionUser) {
    if (existing.ownerId !== user.id) throw new NotFoundException('Объявление не найдено')
    if (existing.status === 'FROZEN' || existing.status === 'BANNED') {
      throw new ForbiddenException('Объявление ограничено модератором')
    }
  }

  private async categoryReady(client: PoolClient, id: string) {
    const { rows } = await client.query(`
      ${visibleCategories} SELECT id FROM available_categories WHERE id = $1
    `, [id])
    if (!rows[0]) throw new BadRequestException('Категория недоступна')
  }

  private async activeUser(client: PoolClient, id: string) {
    const { rows } = await client.query(`
      SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL FOR SHARE
    `, [id])
    if (!rows[0]) throw new ForbiddenException('Профиль недоступен')
  }

  private managementFilters(query: Record<string, unknown>, params: Parameters, filters: string[]) {
    if (query.status) filters.push(`l.status = ${params.add(oneOf(query.status, listingStatuses, 'Статус'))}`)
    if (query.q) {
      const q = params.add(escapedSearch(query.q))
      filters.push(`(l.title ILIKE ${q} OR l.description ILIKE ${q} OR u.display_name ILIKE ${q})`)
    }
  }

  private async listPage(
    db: Queryable,
    filters: string[],
    params: Parameters,
    { page, limit, offset }: ReturnType<typeof pageParams>,
    order: string,
    withClause = '',
  ) {
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countValues = [...params.values]
    const limitParam = params.add(limit)
    const offsetParam = params.add(offset)
    const [items, count] = await Promise.all([
      db.query<ListingRow>(`
        ${withClause} SELECT ${listingColumns} ${listingJoins} ${where}
        ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}
      `, params.values),
      db.query<{ total: number }>(`${withClause} SELECT count(*)::int AS total ${listingJoins} ${where}`, countValues),
    ])
    return { items: items.rows, total: count.rows[0]?.total ?? 0, page, limit }
  }
}
