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

export const listingColumns = `
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
  ), '[]'::jsonb) AS images
`
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
