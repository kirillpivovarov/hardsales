import { representationLabels, representationListingColumns, representationOwnerColumns } from '../exchange/representation.rules'
import { listingModelColumns } from '../models/model-listings'

// Explicit projections keep private account fields out of marketplace responses.
export function publicProfile(alias: string) {
  return `jsonb_build_object(
    'id', ${alias}.id, 'nickname', ${alias}.display_name, 'city', ${alias}.city, 'country', ${alias}.country,
    'accountType', ${alias}.participant_type
  ) || (
    SELECT jsonb_build_object('rating', round(avg(latest.rating), 1), 'ratingCount', count(*))
    FROM (
      SELECT DISTINCT ON (r.author_id) r.rating
      FROM reviews r WHERE r.subject_id = ${alias}.id AND r.status = 'ACTIVE'
      ORDER BY r.author_id, r.created_at DESC, r.id DESC
    ) latest
  )`
}

export const actualityRequestedSql = `coalesce((
  SELECT value = 'true'::jsonb FROM platform_settings WHERE key = 'feature_actuality'
), false)`
export const actualityEnabledSql = `(${actualityRequestedSql} AND coalesce((
  SELECT starts_at <= now() FROM actuality_activation WHERE singleton
), true))`

const actualityTimezoneSql = `coalesce((
  SELECT value #>> '{}' FROM platform_settings WHERE key = 'timezone'
), 'Europe/Moscow')`

export const trustEnabledSql = "EXISTS (SELECT 1 FROM platform_settings WHERE key='feature_trust_rating' AND value='true'::jsonb)"

export function listingColumnsFor(privateActuality = 'false') {
  return `
  l.id, l.owner_id AS "ownerId", l.category_id AS "categoryId", l.kind, l.title, l.description,
  l.quantity, l.condition, l.price_mode AS "priceMode", l.price::float8 AS price, l.currency,
  l.availability, l.origin_scope AS "originScope", l.origin_country AS "originCountry",
  l.destination_country AS "destinationCountry", l.stock_city AS "stockCity", l.delivery_by::text AS "deliveryBy",
  l.delivery_included AS "deliveryIncluded", l.customs_included AS "customsIncluded", l.vat, l.counterparty,
  l.payment_methods AS "paymentMethods", l.specs, l.image_key AS "imageKey", l.status,
  l.created_at AS "createdAt", l.updated_at AS "updatedAt",
  c.name AS "categoryName", c.slug AS "categorySlug", ${publicProfile('u')} AS owner,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', i.id, 'width', i.width, 'height', i.height,
      'url', '/api/v1/listings/' || l.id::text || '/images/' || i.id::text
    ) ORDER BY i.position)
    FROM listing_images i WHERE i.listing_id = l.id
  ), '[]'::jsonb) AS images,
  l.lifetime_days AS "lifetimeDays",
  CASE WHEN ${actualityEnabledSql} THEN l.expires_at END AS "expiresAt",
  CASE WHEN ${actualityEnabledSql} THEN l.confirmed_at END AS "confirmedAt",
  CASE WHEN ${privateActuality} THEN l.asked_at END AS "askedAt",
  CASE WHEN ${privateActuality} THEN l.hidden_at END AS "hiddenAt",
  CASE WHEN ${privateActuality} THEN l.hidden_reason END AS "hiddenReason",
  CASE WHEN ${privateActuality} THEN l.spot_check_hold END AS "spotCheckHold",
  CASE WHEN ${privateActuality} THEN l.archived_reason END AS "archivedReason",
  CASE WHEN ${actualityEnabledSql} AND l.confirmed_at IS NOT NULL THEN (
    SELECT jsonb_build_object('today', f.today, 'hoursAgo', f.hours,
      'label', CASE WHEN f.today THEN 'подтверждено сегодня' ELSE 'подтверждено ' || f.hours || ' ч назад' END)
    FROM (SELECT (l.confirmed_at AT TIME ZONE ${actualityTimezoneSql})::date =
          (now() AT TIME ZONE ${actualityTimezoneSql})::date AS today,
      greatest(0, floor(extract(epoch FROM (now() - l.confirmed_at)) / 3600))::int AS hours) f
  ) END AS freshness,
  CASE WHEN ${actualityEnabledSql} THEN (
    SELECT count(*)::int FROM listing_price_history h
    WHERE h.listing_id = l.id AND h.source <> 'CREATE' AND h.changed_at >= now() - interval '14 days'
  ) ELSE 0 END AS "priceChanges14",
  l.min_lot AS "minLot", l.ship_days AS "shipDays", l.payment_terms AS "paymentTerms",
  ${listingModelColumns}, ${representationListingColumns()},
  ${representationLabels()} AS labels,
  CASE WHEN ${trustEnabledSql} THEN listing_trust_projection(l,u) END AS trust,
  CASE WHEN (${privateActuality}) THEN (SELECT to_jsonb(fields) FROM (
    SELECT ${representationOwnerColumns()},
      CASE WHEN ${trustEnabledSql} THEN l.trust_factors END AS "trustFactors",
      CASE WHEN ${trustEnabledSql} AND l.status = 'ACTIVE' THEN (
        SELECT (s.value #>> '{}')::int FROM platform_settings s
        WHERE s.key = 'low_rating_threshold' AND l.trust_score < (s.value #>> '{}')::int
      ) END AS "hiddenByRatingBelow"
  ) fields) END AS "privateFields"
`
}
export const listingColumns = listingColumnsFor()
export const listingJoins = `FROM listings l JOIN users u ON u.id = l.owner_id JOIN categories c ON c.id = l.category_id`

export const categoryColumns = `
  c.id, c.slug, c.name, c.short_name AS "shortName", c.description, c.icon, c.parent_id AS "parentId",
  c.active, c.sort_order AS "sortOrder", c.attribute_keys AS "attributeKeys", c.translations
`
export const visibleCategories = `
  WITH RECURSIVE available_categories AS (
    SELECT id, parent_id, slug FROM categories WHERE parent_id IS NULL AND active
    UNION ALL
    SELECT c.id, c.parent_id, c.slug FROM categories c JOIN available_categories p ON p.id = c.parent_id WHERE c.active
  )
`
export const listingPublicWhere = `
  l.status = 'ACTIVE' AND u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL
  AND (l.delivery_by IS NULL OR l.delivery_by >= (now() AT TIME ZONE 'UTC')::date)
  AND (NOT ${actualityEnabledSql} OR (u.actuality_suspended_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())))
  AND l.category_id IN (SELECT id FROM available_categories)
`

// Both the listing and its images enforce visibility in the same database snapshot.
export const listingDetailWhere = `
  l.id = $1 AND ($2 OR l.owner_id = $3 OR (l.kind = $4 AND ${listingPublicWhere}))
`

export const listingEditableColumns = [
  'category_id', 'title', 'description', 'quantity', 'condition', 'price_mode', 'price', 'currency',
  'availability', 'origin_scope', 'origin_country', 'destination_country', 'stock_city', 'delivery_by',
  'delivery_included', 'customs_included', 'vat', 'counterparty', 'payment_methods', 'specs',
]
