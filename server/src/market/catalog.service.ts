import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { SessionUser } from '../auth/auth.types'
import { DatabaseService, type Queryable } from '../database/database.service'
import { ListingMediaService, type ListingImage, type ListingImageData, type ListingImageUpdate, type ListingImageUpload } from './listing-media.service'
import {
  accountTypes, availability, boolean, conditions, counterparties, country, currencies, escapedSearch,
  kinds, listingInput, listingStatuses, object, oneOf, originScopes, pageParams, Parameters, paymentMethods,
  priceValue, slug, str, uuid, vatModes,
} from './market.inputs'
import {
  categoryColumns, listingColumns, listingDetailWhere, listingEditableColumns, listingJoins, listingPublicWhere,
  visibleCategories,
} from './market.queries'

type ListingRow = Record<string, unknown> & {
  id: string
  ownerId: string
  kind: typeof kinds[number]
  categoryId: string
  status: typeof listingStatuses[number]
  images: ListingImage[]
}

type ListingSearch = { ctes: string; ownerWords: string }

@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService, private readonly media: ListingMediaService) {}

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
    const search = this.listingSearch(query.q, params, filters)
    const selections = [
      ['ownerType', 'u.participant_type', accountTypes, 'Тип участника'],
      ['availability', 'l.availability', availability, 'Наличие'],
      ['priceMode', 'l.price_mode', ['FIXED', 'NEGOTIABLE'], 'Тип цены'],
      ['vat', 'l.vat', vatModes, 'НДС'],
      ['counterparty', 'l.counterparty', counterparties, 'Тип контрагента'],
    ] as const
    for (const [key, field, valid, label] of selections) {
      if (query[key]) filters.push(`${field} = ${params.add(oneOf(query[key], valid, label))}`)
    }
    if (query.originScope) {
      const scope = oneOf(query.originScope, originScopes, 'География поставки')
      const matching = `l.origin_scope = ${params.add(scope)}`
      filters.push(scope === 'COUNTRY' ? `(${matching} OR (l.kind = 'SELL' AND l.origin_scope IS NULL))` : matching)
    }
    if (query.condition) {
      const condition = oneOf(query.condition, conditions, 'Состояние')
      const matching = `l.condition = ${params.add(condition)}`
      const acceptsAny = condition !== 'ANY' && (allowed || requestedKind) === 'BUY'
      filters.push(acceptsAny ? `(${matching} OR l.condition = 'ANY')` : matching)
    }
    for (const key of ['country', 'originCountry']) {
      const origin = query[key]
      if (!origin) continue
      const matching = origin === 'ANY' ? "l.origin_scope = 'ANY'"
        : `(l.origin_country = ${params.add(country(origin, 'Страна отгрузки'))} OR l.origin_scope = 'ANY')`
      filters.push(matching)
    }
    if (query.destinationCountry) {
      const destination = params.add(country(query.destinationCountry, 'Страна доставки'))
      filters.push(`(l.destination_country = ${destination} OR (l.kind = 'SELL' AND l.destination_country IS NULL))`)
    }
    if (query.ownerCountry) filters.push(`u.country = ${params.add(country(query.ownerCountry, 'Страна участника'))}`)
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
    const sort = query.sort ? oneOf(query.sort, ['relevance', 'newest', 'price-asc', 'price-desc'], 'Сортировка')
      : search ? 'relevance' : 'newest'
    const orders = {
      relevance: search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id',
      newest: 'l.created_at DESC, l.id',
      'price-asc': 'l.currency, l.price ASC NULLS LAST, l.created_at DESC, l.id',
      'price-desc': 'l.currency, l.price DESC NULLS LAST, l.created_at DESC, l.id',
    }
    return {
      ...await this.listPage(this.db, filters, params, paging, orders[sort], visibleCategories, search),
      locked: false,
    }
  }

  async mine(user: SessionUser, query: Record<string, unknown>) {
    const params = new Parameters()
    const filters = [`l.owner_id = ${params.add(user.id)}`]
    const search = this.managementFilters(query, params, filters)
    const order = search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id'
    return this.listPage(this.db, filters, params, pageParams(query), order, '', search)
  }

  async administrativeListings(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    const search = this.managementFilters(query, params, filters)
    if (query.kind) filters.push(`l.kind = ${params.add(oneOf(query.kind, kinds, 'Вид объявления'))}`)
    const order = search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id'
    return this.listPage(this.db, filters, params, pageParams(query), order, '', search)
  }

  async detail(user: SessionUser, idInput: string) {
    const result = await this.db.query<ListingRow>(`
      ${visibleCategories}
      SELECT ${listingColumns} ${listingJoins}
      WHERE ${listingDetailWhere}
    `, this.detailParams(user, idInput))
    return this.found(result.rows[0])
  }

  async image(user: SessionUser, idInput: string, imageIdInput: string) {
    const { rows } = await this.db.query<ListingImageData>(`
      ${visibleCategories}
      SELECT i.content, i.mime_type AS "mimeType"
      ${listingJoins} JOIN listing_images i ON i.listing_id = l.id
      WHERE ${listingDetailWhere} AND i.id = $5
    `, [...this.detailParams(user, idInput), uuid(imageIdInput, 'Фотография')])
    if (!rows[0]) throw new NotFoundException('Фотография не найдена')
    return rows[0]
  }

  async assertEditableBy(user: SessionUser, idInput: string) {
    const { rows } = await this.db.query<Pick<ListingRow, 'ownerId' | 'status'>>(`
      SELECT owner_id AS "ownerId", status FROM listings WHERE id = $1
    `, [uuid(idInput)])
    if (!rows[0]) throw new NotFoundException('Объявление не найдено')
    this.assertOwnership(rows[0], user)
  }

  async show(db: Queryable, id: string) {
    const { rows } = await db.query<ListingRow>(`SELECT ${listingColumns} ${listingJoins} WHERE l.id = $1`, [id])
    return this.found(rows[0])
  }

  async create(user: SessionUser, body: unknown, uploads?: ListingImageUpload[]) {
    if (user.role === 'ADMIN') throw new ForbiddenException('Администратор не публикует объявления')
    const kind = user.role === 'SELLER' ? 'SELL' : 'BUY'
    const raw = object(body)
    if (raw.kind && raw.kind !== kind) throw new ForbiddenException('Вид объявления зависит от роли')
    const values = listingInput(raw, {}, kind)
    const images = await this.media.prepare(raw.imageOrder, uploads)
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
      if (images) await this.media.save(client, rows[0].id, [], images)
      return this.show(client, rows[0].id)
    })
  }

  async change(user: SessionUser, idInput: string, body: unknown, uploads?: ListingImageUpload[]) {
    const id = uuid(idInput)
    const raw = object(body)
    const images = await this.media.prepare(raw.imageOrder, uploads)
    return this.db.transaction(async client => {
      const existing = await this.lock(client, id)
      this.assertOwnership(existing, user)
      await this.activeUser(client, user.id)
      return this.update(client, existing, raw, images)
    })
  }

  async update(client: PoolClient, existing: ListingRow, raw: Record<string, unknown>, images?: ListingImageUpdate) {
    if (raw.kind && raw.kind !== existing.kind) throw new BadRequestException('Вид объявления нельзя изменить')
    const values = listingInput(raw, existing, existing.kind)
    if (values[0] !== existing.categoryId) await this.categoryReady(client, values[0] as string)
    const assignments = listingEditableColumns.map((name, index) => `${name} = $${index + 2}`).join(', ')
    await client.query(`UPDATE listings SET ${assignments}, updated_at = now() WHERE id = $1`, [existing.id, ...values])
    if (images) await this.media.save(client, existing.id, existing.images, images)
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
      throw new BadRequestException(existing.kind === 'BUY' ? 'Перед публикацией обновите срок поставки'
        : 'Перед публикацией обновите срок действия предложения')
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

  private detailParams(user: SessionUser, idInput: string) {
    return [uuid(idInput), user.role === 'ADMIN', user.id, this.oppositeKind(user)]
  }

  private assertOwnership(existing: Pick<ListingRow, 'ownerId' | 'status'>, user: SessionUser) {
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
    return this.listingSearch(query.q, params, filters, true)
  }

  private listingSearch(input: unknown, params: Parameters, filters: string[], includeNickname = false): ListingSearch | undefined {
    if (input === undefined || input === '') return
    const query = str(input, 'Поиск', 0, 200)
    if (!query) return
    const searchParam = params.add(query)
    filters.push('ranking.score IS NOT NULL')
    const ctes = `
      search_query AS (
        SELECT (market_search_words(${searchParam}))[1:20] AS words
      ),
      search_anchor AS (
        SELECT word AS term, CASE WHEN word ~ '^[a-z]{5,32}$'
          THEN market_search_spelling_keys(ARRAY[word]) ELSE '{}'::integer[] END AS spelling_keys
        FROM unnest((SELECT words FROM search_query)) AS word
        -- Prefer a model code or another longer term for an indexed shortlist.
        ORDER BY (word ~ '[0-9]') DESC, length(word) DESC, word
        LIMIT 1
      ),
      matching_categories AS (
        SELECT c.id FROM categories c CROSS JOIN search_anchor a
        WHERE c.search_words @> ARRAY[a.term]
          OR (cardinality(a.spelling_keys) > 0 AND market_search_spelling_keys(c.search_words) && a.spelling_keys)
      ),
      matching_owners AS (
        SELECT u.id FROM users u CROSS JOIN search_anchor a
        WHERE u.search_words @> ARRAY[a.term]
          OR (cardinality(a.spelling_keys) > 0 AND market_search_spelling_keys(u.search_words) && a.spelling_keys)
      ),
      matching_candidates AS (
        SELECT l.id FROM listings l CROSS JOIN search_anchor a
        WHERE l.search_words @> ARRAY[a.term] OR market_search_spelling_keys(l.search_words) && a.spelling_keys
        UNION
        SELECT l.id FROM listings l JOIN matching_categories c ON c.id = l.category_id
        UNION
        SELECT l.id FROM listings l JOIN matching_owners u ON u.id = l.owner_id
      )
    `
    return { ctes, ownerWords: includeNickname ? 'u.search_words' : 'u.search_city_words' }
  }

  private async listPage(
    db: Queryable,
    filters: string[],
    params: Parameters,
    { page, limit, offset }: ReturnType<typeof pageParams>,
    order: string,
    withClause = '',
    search?: ListingSearch,
  ) {
    // Limit the lateral query to one score calculation per matched listing.
    const preamble = search ? (withClause ? withClause + ',' : 'WITH ') + search.ctes : withClause
    const joins = listingJoins + (search ? `
      JOIN matching_candidates candidate ON candidate.id = l.id
      CROSS JOIN search_query
      CROSS JOIN LATERAL (
        SELECT market_search_rank(search_query.words, l.search_title_words, l.search_words, c.search_words || ${search.ownerWords}) AS score
        LIMIT 1
      ) ranking
    ` : '')
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countValues = [...params.values]
    const limitParam = params.add(limit)
    const offsetParam = params.add(offset)
    const [items, count] = await Promise.all([
      db.query<ListingRow>(`
        ${preamble} SELECT ${listingColumns} ${joins} ${where}
        ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}
      `, params.values),
      db.query<{ total: number }>(`${preamble} SELECT count(*)::int AS total ${joins} ${where}`, countValues),
    ])
    return { items: items.rows, total: count.rows[0]?.total ?? 0, page, limit }
  }
}
