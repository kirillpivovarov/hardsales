import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import type { ExchangeClock } from '../exchange/jobs';
import { listingPublicWhere, visibleCategories } from '../market/market.queries';
import { evaluatePair, explainPair, type Compatibility, type ListingForMatch, type MatchModel, type Rates } from './matching.rules';

const compatibility = JSON.parse(readFileSync(resolve(__dirname, '../../seeds/exchange_data/payment_compatibility.json'), 'utf8')) as Compatibility;

// Keep the visibility predicate aligned with the manual catalog. The lateral query can
// use the partial seller/model index without constructing a cross product.
const listingMatchColumns = `l.id, l.owner_id, l.title, l.kind, l.model_id, l.analog_model_ids, l.condition,
  l.quantity, l.min_lot, l.ship_days, l.origin_scope, l.origin_country, l.destination_country,
  l.counterparty, u.participant_type, l.delivery_by::text, l.price_mode, l.price::text,
  l.currency, l.payment_terms, l.payment_methods, l.representation, l.confirmed_at`;
const visibleForMatching = `${listingPublicWhere} AND u.onboarding_state <> 'REQUIRED' AND u.actuality_suspended_at IS NULL`;

export const eligibleListings = `
  ${visibleCategories}, eligible AS NOT MATERIALIZED (
    SELECT ${listingMatchColumns}
    FROM listings l JOIN users u ON u.id = l.owner_id
    JOIN hardware_models h ON h.id = l.model_id AND h.status = 'ACTIVE'
    WHERE ${visibleForMatching}
  )
`;
const operatorEligible = `operator_eligible AS NOT MATERIALIZED (
  SELECT ${listingMatchColumns}, c.slug AS category_slug, u.display_name AS nickname
  FROM listings l JOIN users u ON u.id = l.owner_id JOIN categories c ON c.id = l.category_id
  LEFT JOIN hardware_models h ON h.id = l.model_id
  WHERE ${visibleForMatching} AND (l.model_id IS NULL OR h.status = 'ACTIVE')
)`;
export const operatorEligibleListings = `${visibleCategories}, ${operatorEligible}`;
export const matchingLock = 12;

type Pair = {
  matchId: string | null; sell: ListingForMatch | null; buy: ListingForMatch | null;
  sellId: string; buyId: string; sellStatus: string | null; buyStatus: string | null; disabled: boolean;
  operator: boolean; operatorVisible: boolean;
};

type MatchChange = {
  sellId: string; buyId: string; seller: string; buyer: string;
  type: string; mismatches: unknown; terms: readonly string[]; methods: readonly string[]; gap: unknown;
};

function voidReason(pair: Pair) {
  const statuses = [pair.sellStatus, pair.buyStatus];
  if (statuses.includes('HIDDEN')) return 'Объявление скрыто: автор не подтвердил актуальность';
  if (statuses.includes('ARCHIVED')) return 'Объявление снято';
  if (statuses.includes('FROZEN') || statuses.includes('BANNED')) return 'Объявление ограничено модератором';
  if (pair.disabled) return 'Модель выключена в справочнике';
  if (pair.operator) return 'Объявление больше недоступно';
  return 'Условия объявлений больше не совпадают';
}

export function compareListings(sell: ListingForMatch, buy: ListingForMatch, day: string, rates: Rates) {
  return evaluatePair(sell, buy, day, rates, compatibility);
}

export function explainListings(sell: ListingForMatch, buy: ListingForMatch, day: string, rates: Rates,
  models: { sell: MatchModel | null; buy: MatchModel | null }) {
  return explainPair(sell, buy, day, rates, compatibility, models);
}

export async function matchingRates(client: PoolClient): Promise<Rates> {
  const { rows } = await client.query<{ currency: string; rate: string | null }>(
    'SELECT currency, usd_per_unit::text AS rate FROM fx_rates',
  );
  return Object.fromEntries(rows.map(({ currency, rate }) => [currency, rate]));
}

const existing = `
  SELECT m.id AS "matchId", to_jsonb(s) AS sell, to_jsonb(b) AS buy,
    l.id AS "sellId", r.id AS "buyId", l.status AS "sellStatus", r.status AS "buyStatus",
    (coalesce(sh.status <> 'ACTIVE', false) OR coalesce(bh.status <> 'ACTIVE', false)
      OR coalesce(oh.status <> 'ACTIVE', false)) AS disabled,
    m.source = 'OPERATOR' AS operator, os.id IS NOT NULL AND ob.id IS NOT NULL AS "operatorVisible"
  FROM listing_matches m JOIN listings l ON l.id = m.sell_listing_id JOIN listings r ON r.id = m.buy_listing_id
  LEFT JOIN hardware_models sh ON sh.id = l.model_id LEFT JOIN hardware_models bh ON bh.id = r.model_id
  LEFT JOIN hardware_models oh ON oh.id = m.operator_model_id
  LEFT JOIN eligible s ON s.id = l.id AND m.source = 'SYSTEM'
  LEFT JOIN eligible b ON b.id = r.id AND m.source = 'SYSTEM'
  LEFT JOIN operator_eligible os ON os.id = l.id AND m.source = 'OPERATOR'
  LEFT JOIN operator_eligible ob ON ob.id = r.id AND m.source = 'OPERATOR'
  WHERE m.status IN ('NEW', 'CHAT', 'VOID')
`;

async function selectPairs(client: PoolClient, listingId: string | null, buyerIds: string[] | null, limit: number | null) {
  const { rows } = await client.query<Pair>(`
    ${eligibleListings}, ${operatorEligible},
    affected_buyers AS NOT MATERIALIZED (
      SELECT b.* FROM eligible b WHERE b.kind = 'BUY' AND (
        b.id = ANY($2::uuid[]) OR b.id = $1 OR (
          $1::uuid IS NOT NULL AND EXISTS (
            SELECT 1 FROM listings l WHERE l.id = $1 AND l.kind = 'SELL'
            AND (b.model_id = l.model_id OR b.analog_model_ids @> ARRAY[l.model_id])
          )
        )
      )
    ), pairs AS (
      ${existing}
        AND (m.sell_listing_id = $1 OR m.buy_listing_id = $1 OR m.buy_listing_id = ANY($2::uuid[]))
      UNION ALL
      SELECT NULL, to_jsonb(s), to_jsonb(b), s.id, b.id, NULL, NULL, false, false, false
      FROM affected_buyers b
      CROSS JOIN LATERAL (
        SELECT * FROM eligible s WHERE s.kind = 'SELL'
          AND s.model_id = ANY(array_prepend(b.model_id, b.analog_model_ids)) AND s.owner_id <> b.owner_id
        ORDER BY s.confirmed_at DESC NULLS LAST, s.id LIMIT 200
      ) s
      WHERE ($1::uuid IS NULL OR b.id = $1 OR s.id = $1)
        AND NOT EXISTS (SELECT 1 FROM listing_matches m WHERE m.sell_listing_id = s.id AND m.buy_listing_id = b.id)
    )
    SELECT * FROM pairs ORDER BY ("matchId" IS NULL), "buyId", "sellId" LIMIT $3
  `, [listingId, buyerIds, limit]);
  return rows;
}

async function savePairs(client: PoolClient, pairs: Pair[], clock: ExchangeClock, rates: Rates, initial: boolean) {
  const changes: MatchChange[] = [];
  const voids: { id: string; reason: string }[] = [];
  const restoreOperator: string[] = [];
  for (const pair of pairs) {
    if (pair.operator && pair.matchId) {
      if (pair.operatorVisible && !pair.disabled) restoreOperator.push(pair.matchId);
      else voids.push({ id: pair.matchId, reason: voidReason(pair) });
      continue;
    }
    const { sell, buy } = pair;
    const evaluation = sell && buy ? compareListings(sell, buy, clock.day, rates) : null;
    if (evaluation && sell && buy) {
      changes.push({
        sellId: sell.id, buyId: buy.id, seller: sell.owner_id, buyer: buy.owner_id,
        type: evaluation.type, mismatches: evaluation.mismatches, terms: evaluation.commonTerms,
        methods: evaluation.commonMethods, gap: evaluation.gap,
      });
    } else if (pair.matchId) {
      voids.push({ id: pair.matchId, reason: voidReason(pair) });
    }
  }
  for (let i = 0; i < changes.length; i += 1000) {
    await client.query(`
      INSERT INTO listing_matches (sell_listing_id, buy_listing_id, seller_id, buyer_id,
        type, mismatches, common_terms, common_methods, gap, initial_batch)
      SELECT "sellId", "buyId", seller, buyer, type, mismatches, terms, methods, gap, $2
      FROM jsonb_to_recordset($1) AS x("sellId" uuid, "buyId" uuid, seller uuid, buyer uuid,
        type text, mismatches jsonb, terms text[], methods text[], gap jsonb)
      ON CONFLICT (sell_listing_id, buy_listing_id) DO UPDATE SET
        type = EXCLUDED.type, mismatches = EXCLUDED.mismatches, common_terms = EXCLUDED.common_terms,
        common_methods = EXCLUDED.common_methods, gap = EXCLUDED.gap, updated_at = now(),
        status = CASE WHEN listing_matches.status = 'VOID' THEN listing_matches.previous_status ELSE listing_matches.status END,
        previous_status = NULL, void_reason = NULL
      WHERE listing_matches.source = 'SYSTEM' AND listing_matches.status IN ('NEW', 'CHAT', 'VOID')
    `, [JSON.stringify(changes.slice(i, i + 1000)), initial]);
  }
  if (voids.length) {
    await client.query(`
      UPDATE listing_matches m SET previous_status = CASE WHEN m.status = 'VOID' THEN m.previous_status ELSE m.status END,
        status = 'VOID', void_reason = x.reason, updated_at = now()
      FROM jsonb_to_recordset($1) AS x(id uuid, reason text)
      WHERE m.id = x.id AND m.status IN ('NEW', 'CHAT', 'VOID')
        AND (m.status <> 'VOID' OR m.void_reason IS DISTINCT FROM x.reason)
    `, [JSON.stringify(voids)]);
  }
  if (restoreOperator.length) await client.query(`
    UPDATE listing_matches SET status = coalesce(previous_status, 'NEW'), previous_status = NULL,
      void_reason = NULL, updated_at = now()
    WHERE id = ANY($1::uuid[]) AND source = 'OPERATOR' AND status = 'VOID'
  `, [restoreOperator]);
  return { evaluated: pairs.length, valid: changes.length + restoreOperator.length };
}

export async function isInitialPass(client: PoolClient) {
  const { rows: [row] } = await client.query<{ initial: boolean }>(`
    SELECT NOT EXISTS (
      SELECT 1 FROM job_runs WHERE job = 'matching.recompute' AND status = 'DONE' AND stats->>'enabled' = 'true'
    ) AS initial
  `);
  return row.initial;
}

export async function recomputeListingPairs(client: PoolClient, listingId: string, clock: ExchangeClock, rates: Rates, initial: boolean) {
  return savePairs(client, await selectPairs(client, listingId, null, 500), clock, rates, initial);
}

export async function recomputeAllPairs(client: PoolClient, clock: ExchangeClock, rates: Rates, initial: boolean) {
  // Include former buyer listings so archived/disabled pairs can still move to VOID.
  let cursor: string | null = null;
  let evaluated = 0;
  let valid = 0;
  for (;;) {
    const pages: { rows: { id: string }[] } = await client.query<{ id: string }>(`
      SELECT id FROM listings l WHERE l.kind = 'BUY' AND ($1::uuid IS NULL OR l.id > $1)
        AND (l.model_id IS NOT NULL OR EXISTS (SELECT 1 FROM listing_matches m WHERE m.buy_listing_id = l.id))
      ORDER BY l.id LIMIT 50
    `, [cursor]);
    const buyerIds = pages.rows.map(row => row.id);
    if (!buyerIds.length) return { evaluated, valid };
    const result = await savePairs(client, await selectPairs(client, null, buyerIds, null), clock, rates, initial);
    evaluated += result.evaluated;
    valid += result.valid;
    cursor = buyerIds[buyerIds.length - 1];
  }
}
