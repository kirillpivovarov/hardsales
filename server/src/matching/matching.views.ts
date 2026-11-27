import { representationLabels } from '../exchange/representation.rules';
import { publicProfile, trustEnabledSql } from '../market/market.queries';
import { totalPriceUsdSql } from '../market/listing-price';

function publicMatchListing(alias: 's' | 'b', owner: 'seller' | 'buyer') {
  return `jsonb_build_object(
    'id', ${alias}.id, 'kind', ${alias}.kind, 'title', ${alias}.title, 'quantity', ${alias}.quantity,
    'minLot', ${alias}.min_lot, 'condition', ${alias}.condition,
    'originCountry', ${alias}.origin_country, 'originScope', ${alias}.origin_scope,
    'destinationCountry', ${alias}.destination_country, 'stockCity', ${alias}.stock_city,
    'shipDays', ${alias}.ship_days, 'deliveryBy', ${alias}.delivery_by,
    'price', ${alias}.price, 'currency', ${alias}.currency,
    'unitPrice', ${alias}.price, 'totalPrice', ${alias}.price * ${alias}.quantity,
    'unitPriceUsd', ${alias}.price_usd, 'totalPriceUsd', ${totalPriceUsdSql(alias)},
    'paymentMethods', ${alias}.payment_methods, 'paymentTerms', ${alias}.payment_terms,
    'labels', (SELECT ${representationLabels()} FROM (SELECT ${alias}.*) l CROSS JOIN (SELECT ${owner}.*) u)
  )`;
}

export const matchJoins = `
  FROM listing_matches m JOIN listings s ON s.id = m.sell_listing_id
  JOIN listings b ON b.id = m.buy_listing_id
  JOIN users seller ON seller.id = m.seller_id JOIN users buyer ON buyer.id = m.buyer_id
  LEFT JOIN hardware_models h ON h.id = coalesce(m.operator_model_id, s.model_id)
`;
export const matchColumns = `
  m.id, m.number::float8 AS number, m.type, m.status, m.created_at AS "createdAt", m.updated_at AS "updatedAt",
  m.mismatches, m.common_terms AS "commonTerms", m.common_methods AS "commonMethods", m.gap,
  m.source, m.operator_comment AS "operatorComment",
  m.source = 'OPERATOR' AND greatest(s.updated_at, b.updated_at) > m.proposed_at AS "operatorConditionsChanged",
  m.chat_id AS "chatId", m.void_reason AS "voidReason", m.decline_reason AS "declineReason",
  CASE WHEN h.id IS NOT NULL THEN jsonb_build_object('id', h.id, 'nameRu', h.name_ru, 'nameEn', h.name_en,
    'byTitle', m.operator_model_id IS NOT NULL,
    'viaAnalog', s.model_id IS NOT NULL AND b.model_id IS NOT NULL AND s.model_id <> b.model_id AND (
      m.source = 'SYSTEM' OR s.model_id = ANY(b.analog_model_ids) OR EXISTS (
        SELECT 1 FROM model_analog_group_members sg JOIN model_analog_group_members bg ON bg.group_id = sg.group_id
        WHERE sg.model_id = s.model_id AND bg.model_id = b.model_id
      ))) END AS model
`;

function counterpart(listing: 's' | 'b', owner: 'seller' | 'buyer') {
  return `jsonb_build_object('listing', ${publicMatchListing(listing, owner)}, 'owner', ${publicProfile(owner)},
    'trust', CASE WHEN ${trustEnabledSql} THEN listing_trust_projection(${listing}, ${owner}) END)`;
}

export const participantMatchColumns = `
  ${matchColumns},
  CASE WHEN m.seller_id = $1 THEN 'SELL' ELSE 'BUY' END AS side,
  jsonb_build_object('id', CASE WHEN m.seller_id = $1 THEN s.id ELSE b.id END,
    'title', CASE WHEN m.seller_id = $1 THEN s.title ELSE b.title END,
    'kind', CASE WHEN m.seller_id = $1 THEN 'SELL' ELSE 'BUY' END) AS mine,
  CASE WHEN m.seller_id = $1 THEN ${counterpart('b', 'buyer')}
    ELSE ${counterpart('s', 'seller')} END AS counterpart
`;
export const member = '(m.seller_id = $1 OR m.buyer_id = $1)';

export const adminMatchColumns = `
  ${matchColumns},
  CASE WHEN m.proposed_by IS NOT NULL THEN (
    SELECT jsonb_build_object('id', u.id, 'nickname', u.display_name) FROM users u WHERE u.id = m.proposed_by
  ) END AS "proposedBy",
  m.proposed_at AS "proposedAt", m.operator_failures AS "operatorFailures",
  jsonb_build_object('listing', to_jsonb(s), 'owner', ${publicProfile('seller')}
    || jsonb_build_object('companyName', seller.company_name, 'email', seller.email, 'telegram', seller.telegram)) AS seller,
  jsonb_build_object('listing', to_jsonb(b), 'owner', ${publicProfile('buyer')}
    || jsonb_build_object('companyName', buyer.company_name, 'email', buyer.email, 'telegram', buyer.telegram)) AS buyer
`;
