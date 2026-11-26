import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { isStaffRole, type ParticipantRole, type SessionUser } from '../auth/auth.types'
import { withoutLegacyListingContacts, type PublicListingText } from '../contact-guard/public-text'
import { DatabaseService, type Queryable } from '../database/database.service'
import { ActualityService } from '../exchange/actuality.service'
import { OnboardingService } from '../exchange/onboarding.service'
import { PlatformSettings } from '../exchange/platform-settings'
import { paymentForms } from '../exchange/trust-score'
import { TrustService } from '../exchange/trust.service'
import { listingRepresentation, representationEnabled, verifiedPrincipal } from '../exchange/representation.rules'
import { listingModelFilter, lockHardwareModelReferences, validateListingModels } from '../models/model-listings'
import { MatchingService } from '../matching/matching.service'
import { lotMembershipJoin } from '../lots/lot-public'
import { ListingMediaService, type ListingImage, type ListingImageData, type ListingImageUpdate, type ListingImageUpload } from './listing-media.service'
import {
  accountTypes, availability, boolean, conditions, counterparties, country, currencies, escapedSearch,
  integer, kinds, listingInput, listingStatuses, object, oneOf, originScopes, pageParams, Parameters, paymentMethods,
  priceValue, slug, str, uuid, vatModes,
} from './market.inputs'
import {
  categoryColumns, listingColumnsFor, listingDetailWhere, listingEditableColumns, listingJoins, listingPublicWhere,
  visibleCategories,
} from './market.queries'

type ListingRow = Record<string, unknown> & PublicListingText & {
  id: string
  ownerId: string
  kind: typeof kinds[number]
  categoryId: string
  status: typeof listingStatuses[number]
  images: ListingImage[]
}

const exchangeColumns = ['lifetime_days', 'min_lot', 'ship_days', 'payment_terms', 'model_id', 'analog_model_ids',
  'representation', 'principal_id', 'agent_fee_disclosed', 'agent_fee_kind', 'agent_fee_value', 'agent_fee_payer'];
const editableColumns = [...listingEditableColumns, ...exchangeColumns];
const allowedPaymentTerms = paymentForms.payment_terms.map(term => term.code);

type ListingSearch = { ctes: string; ownerWords: string }

@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService, private readonly media: ListingMediaService,
    private readonly actuality: ActualityService, private readonly onboarding: OnboardingService,
    private readonly trust: TrustService, private readonly settings: PlatformSettings,
    private readonly matching: MatchingService) {}

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
    const allowed = isStaffRole(user.role) ? null : this.oppositeKind(user)
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
    if (query.model) filters.push(listingModelFilter(query.model, query.withAnalogs, params))
    if (query.representation) {
      filters.push(representationEnabled)
      filters.push(`l.representation = ${params.add(oneOf(query.representation, ['DIRECT','AGENT'], 'Представительство'))}`)
    }
    if (query.principalConfirmed === 'true' || query.principalConfirmed === true) filters.push(verifiedPrincipal)
    const trustEnabled = await this.settings.enabled('feature_trust_rating')
    const lowRating = trustEnabled && query.showAll !== 'true' && query.showAll !== true
      ? `l.trust_score < ${params.add(await this.settings.get<number>('low_rating_threshold'))}` : undefined
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
    const sort = query.sort ? oneOf(query.sort, ['relevance', 'newest', 'price-asc', 'price-desc', 'trust'], 'Сортировка')
      : search ? 'relevance' : trustEnabled ? 'trust' : 'newest'
    const orders = {
      relevance: search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id',
      newest: 'l.created_at DESC, l.id',
      trust: trustEnabled ? 'l.trust_score DESC NULLS LAST, l.created_at DESC, l.id' : 'l.created_at DESC, l.id',
      'price-asc': 'l.currency, l.price ASC NULLS LAST, l.created_at DESC, l.id',
      'price-desc': 'l.currency, l.price DESC NULLS LAST, l.created_at DESC, l.id',
    }
    const [page, maskLegacyContacts] = await Promise.all([
      this.listPage(this.db, filters, params, paging, orders[sort], visibleCategories, search, false, lowRating,
        user.role === 'BUYER' && await this.settings.enabled('feature_lot_groups')),
      allowed !== null && this.settings.enabled('feature_disclosure_journal'),
    ])
    if (maskLegacyContacts) page.items = page.items.map(item => item.ownerId === user.id ? item : withoutLegacyListingContacts(item))
    return { ...page, locked: false }
  }

  async mine(user: SessionUser<ParticipantRole>, query: Record<string, unknown>) {
    const params = new Parameters()
    const filters = [`l.owner_id = ${params.add(user.id)}`]
    if (query.publication) {
      const publication = oneOf(query.publication, ['current', 'archive', 'restricted'], 'Публикация')
      const statuses = { current: ['ACTIVE','HIDDEN'], archive: ['ARCHIVED'], restricted: ['FROZEN','BANNED'] }
      filters.push(`l.status = ANY(${params.add(statuses[publication])}::text[])`)
    }
    const search = this.managementFilters(query, params, filters)
    const order = search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id'
    return this.listPage(this.db, filters, params, pageParams(query), order, '', search, true)
  }

  async administrativeListings(query: Record<string, unknown>) {
    const params = new Parameters()
    const filters: string[] = []
    const search = this.managementFilters(query, params, filters)
    if (query.kind) filters.push(`l.kind = ${params.add(oneOf(query.kind, kinds, 'Вид объявления'))}`)
    const order = search ? 'ranking.score DESC, l.created_at DESC, l.id' : 'l.created_at DESC, l.id'
    return this.listPage(this.db, filters, params, pageParams(query), order, '', search, true)
  }

  async detail(user: SessionUser, idInput: string) {
    const result = await this.db.query<ListingRow>(`
      ${visibleCategories}
      SELECT ${listingColumnsFor('$2 OR l.owner_id = $3')} ${listingJoins}
      WHERE ${listingDetailWhere}
    `, this.detailParams(user, idInput))
    const listing = this.found(result.rows[0])
    return listing.ownerId !== user.id && !isStaffRole(user.role) && await this.settings.enabled('feature_disclosure_journal')
      ? withoutLegacyListingContacts(listing)
      : listing
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

  async assertEditableBy(user: SessionUser<ParticipantRole>, idInput: string) {
    const { rows } = await this.db.query<Pick<ListingRow, 'ownerId' | 'status'>>(`
      SELECT owner_id AS "ownerId", status FROM listings WHERE id = $1
    `, [uuid(idInput)])
    if (!rows[0]) throw new NotFoundException('Объявление не найдено')
    this.assertOwnership(rows[0], user)
  }

  async show(db: Queryable, id: string) {
    const { rows } = await db.query<ListingRow>(`SELECT ${listingColumnsFor('true')} ${listingJoins} WHERE l.id = $1`, [id])
    return this.found(rows[0])
  }

  async create(user: SessionUser<ParticipantRole>, body: unknown, uploads?: ListingImageUpload[]) {
    const kind = user.role === 'SELLER' ? 'SELL' : 'BUY'
    const raw = object(body)
    if (raw.kind && raw.kind !== kind) throw new ForbiddenException('Вид объявления зависит от роли')
    const values = listingInput(raw, {}, kind)
    const images = await this.media.prepare(raw.imageOrder, uploads)
    return this.db.transaction(async client => {
      await lockHardwareModelReferences(client)
      await this.activeUser(client, user.id)
      await this.trust.assertPublishable(client, user.id, { creating: true })
      await this.onboarding.assertCanPublish(user.id, client)
      await this.actuality.assertCanActivate(client, user.id)
      const categoryId = values[0] as string
      await this.categoryReady(client, categoryId)
      const extra = await this.exchangeValues(client, user.id, kind, values[3] as number, categoryId, raw)
      const markers = editableColumns.map((_, index) => `$${index + 3}`).join(', ')
      const { rows } = await client.query<{ id: string }>(`
        INSERT INTO listings (owner_id, kind, ${editableColumns.join(', ')})
        SELECT $1, $2, ${markers} FROM users WHERE id = $1 AND
          status = 'ACTIVE' AND email_verified_at IS NOT NULL FOR SHARE
        RETURNING id
      `, [user.id, kind, ...values, ...extra])
      if (!rows[0]) throw new ForbiddenException('Профиль недоступен')
      if (images) await this.media.save(client, rows[0].id, [], images)
      await this.trust.refresh(client, user.id)
      await this.matching.recomputeListing(client, rows[0].id)
      return this.show(client, rows[0].id)
    })
  }

  async change(user: SessionUser<ParticipantRole>, idInput: string, body: unknown, uploads?: ListingImageUpload[]) {
    const id = uuid(idInput)
    const raw = object(body)
    const images = await this.media.prepare(raw.imageOrder, uploads)
    return this.db.transaction(async client => {
      await lockHardwareModelReferences(client)
      await this.activeUser(client, user.id)
      await this.trust.assertPublishable(client, user.id, { creating: false })
      await this.onboarding.assertCanPublish(user.id, client)
      const existing = await this.lock(client, id)
      this.assertOwnership(existing, user)
      if (existing.status === 'HIDDEN') throw new ConflictException('Сначала восстановите скрытое объявление')
      return this.update(client, existing, raw, images, true)
    })
  }

  async update(client: PoolClient, existing: ListingRow, raw: Record<string, unknown>, images?: ListingImageUpdate, ownerEdit = false) {
    if (raw.kind && raw.kind !== existing.kind) throw new BadRequestException('Вид объявления нельзя изменить')
    const values = listingInput(raw, existing, existing.kind)
    if (values[0] !== existing.categoryId) await this.categoryReady(client, values[0] as string)
    const extra = await this.exchangeValues(client, existing.ownerId, existing.kind, values[3] as number, values[0] as string, raw, existing)
    const assignments = editableColumns.map((name, index) => `${name} = $${index + 2}`).join(', ')
    await client.query(`UPDATE listings SET ${assignments}, updated_at = now() WHERE id = $1`, [existing.id, ...values, ...extra])
    if (images) await this.media.save(client, existing.id, existing.images, images)
    if (ownerEdit) await this.actuality.recordOwnerEdit(client, existing.id)
    await this.trust.refresh(client, existing.ownerId)
    await this.matching.recomputeListing(client, existing.id)
    return this.show(client, existing.id)
  }

  async archive(user: SessionUser<ParticipantRole>, idInput: string, restore = false) {
    const id = uuid(idInput)
    return this.db.transaction(async client => {
      await lockHardwareModelReferences(client)
      await this.activeUser(client, user.id)
      const existing = await this.lock(client, id)
      this.assertOwnership(existing, user)
      if (restore && existing.isDuplicate) {
        throw new ConflictException('Объявление помечено как дубль. Оспорить решение можно у модератора.')
      }
      if (restore && existing.status !== 'ACTIVE') {
        await this.trust.assertPublishable(client, user.id, { creating: existing.status === 'ARCHIVED' })
        await this.onboarding.assertCanPublish(user.id, client)
      }
      if (restore) await this.assertRepublishable(client, existing)
      await this.actuality.ownerArchive(client, user.id, id, restore)
      await this.trust.refresh(client, user.id)
      await this.matching.recomputeListing(client, id)
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
    await lockHardwareModelReferences(client)
    const result = await client.query('SELECT id FROM listings WHERE id = $1 FOR UPDATE', [id])
    if (!result.rows[0]) throw new NotFoundException('Объявление не найдено')
    return this.show(client, id)
  }

  async lockListingOwner(client: PoolClient, id: string) {
    await lockHardwareModelReferences(client)
    const { rows: [owner] } = await client.query<{ id: string }>(`
      SELECT u.id FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = $1 FOR UPDATE OF u
    `, [id]);
    if (!owner) throw new NotFoundException('Объявление не найдено')
    return owner.id
  }

  private found(row?: ListingRow): ListingRow {
    if (!row) throw new NotFoundException('Объявление не найдено')
    const { privateFields, ...publicFields } = row
    return { ...publicFields, ...(privateFields && typeof privateFields === 'object' ? privateFields : {}) } as ListingRow
  }

  private async exchangeValues(client: PoolClient, ownerId: string, kind: ListingRow['kind'], quantity: number,
    categoryId: string, raw: Record<string, unknown>, existing?: ListingRow) {
    const value = (key: string) => Object.hasOwn(raw, key) ? raw[key] : existing?.[key]
    const lifetime = integer(value('lifetimeDays') ?? (kind === 'BUY' ? 21 : 14), 'Срок размещения', 1, 60)
    const defaultMinimum = Math.min(Number(existing?.minLot ?? 1), quantity)
    const minimum = integer(raw.minLot ?? defaultMinimum, 'Минимальная партия', 1, quantity)
    const days = value('shipDays')
    const shipping = kind === 'SELL' && days !== null && days !== undefined ? integer(days, 'Дни отгрузки', 0, 365) : null
    const rawTerms = value('paymentTerms') ?? []
    if (!Array.isArray(rawTerms) || rawTerms.length > allowedPaymentTerms.length) throw new BadRequestException('Неверные условия оплаты')
    const terms = [...new Set(rawTerms.map(term => oneOf(term, allowedPaymentTerms, 'Условия оплаты')))]
    const models = await validateListingModels(client, raw, existing ?? {}, categoryId, kind, ownerId)
    const rep = await listingRepresentation(client, ownerId, raw, existing)
    return [lifetime, minimum, shipping, terms, ...models, rep.representation, rep.principalId,
      rep.agentFeeDisclosed, rep.agentFeeKind, rep.agentFeeValue, rep.agentFeePayer]
  }

  private oppositeKind(user: SessionUser): typeof kinds[number] {
    return user.role === 'SELLER' ? 'BUY' : 'SELL'
  }

  private detailParams(user: SessionUser, idInput: string) {
    return [uuid(idInput), isStaffRole(user.role), user.id, this.oppositeKind(user)]
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
      SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL FOR UPDATE
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
    privateFields = false,
    lowRating?: string,
    collapseLots = false,
  ) {
    // Limit the lateral query to one score calculation per matched listing.
    let preamble = search ? (withClause ? withClause + ',' : 'WITH ') + search.ctes : withClause
    const joins = listingJoins + (search ? `
      JOIN matching_candidates candidate ON candidate.id = l.id
      CROSS JOIN search_query
      CROSS JOIN LATERAL (
        SELECT market_search_rank(search_query.words, l.search_title_words, l.search_words, c.search_words || ${search.ownerWords}) AS score
        LIMIT 1
      ) ranking
    ` : '')
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const visible = lowRating ? `(${lowRating}) IS NOT TRUE` : undefined
    const itemsWhere = visible ? `${where ? where + ' AND' : 'WHERE'} ${visible}` : where
    const totals = visible
      ? `count(*) FILTER (WHERE ${visible})::int AS total, count(*) FILTER (WHERE ${lowRating})::int AS "hiddenLowRating"`
      : 'count(*)::int AS total'
    const countValues = [...params.values]
    const limitParam = params.add(limit)
    const offsetParam = params.add(offset)
    if (collapseLots) {
      // Rank only offers that match this search so grouping cannot hide a matching alternative.
      preamble += `, lot_ranked AS (
        SELECT l.id,lg.id AS group_id,row_number() OVER (
          PARTITION BY coalesce(lg.id,l.id) ORDER BY l.trust_score DESC NULLS LAST,l.created_at,l.id
        ) AS position
        ${joins} ${lotMembershipJoin} ${itemsWhere}
      )`
      const [items, count] = await Promise.all([
        db.query<ListingRow>(`
          ${preamble} SELECT ${listingColumnsFor()},CASE WHEN group_size.participants > 1 THEN jsonb_build_object(
            'id',lot.group_id,'participants',group_size.participants,'primary',true,'collapsedCount',group_size.participants-1
          ) END AS "lotGroup"
          ${joins} JOIN lot_ranked lot ON lot.id=l.id AND lot.position=1
          LEFT JOIN LATERAL (
            SELECT count(DISTINCT l.owner_id)::int AS participants
            FROM lot_group_members peer JOIN lot_groups grp ON grp.id=peer.group_id
            JOIN listings l ON l.id=peer.listing_id AND l.lot_key=grp.lot_key JOIN users u ON u.id=l.owner_id
            WHERE peer.group_id=lot.group_id AND peer.role='MEMBER' AND ${listingPublicWhere}
          ) group_size ON lot.group_id IS NOT NULL
          ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}
        `, params.values),
        db.query<{ total: number; hiddenLowRating?: number }>(`
          ${preamble} SELECT (SELECT count(*)::int FROM lot_ranked WHERE position=1) AS total
          ${lowRating ? `, (SELECT count(*)::int ${joins} ${where}${where ? ' AND ' : 'WHERE '}${lowRating}) AS "hiddenLowRating"` : ''}
        `, countValues),
      ])
      return { items: items.rows.map(row => this.found(row)), ...count.rows[0], page, limit }
    }
    const [items, count] = await Promise.all([
      db.query<ListingRow>(`
        ${preamble} SELECT ${listingColumnsFor(privateFields ? 'true' : 'false')} ${joins} ${itemsWhere}
        ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}
      `, params.values),
      db.query<{ total: number; hiddenLowRating?: number }>(`${preamble} SELECT ${totals} ${joins} ${where}`, countValues),
    ])
    return { items: items.rows.map(row => this.found(row)), ...count.rows[0], page, limit }
  }
}
