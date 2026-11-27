import { demoMode } from '../config';
import type { Queryable } from '../database/database.service';
import { listingPublicWhere, visibleCategories } from '../market/market.queries';
import type { PilotPeriod } from './pilot.settings';

const demoMembers = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000004',
];

export function exclusions(configured: string[]): string[] {
  return demoMode() ? [...new Set([...configured, ...demoMembers])] : configured;
}

const eligibleMembers = (excluded: '$1' | '$4') => `participants AS (
  SELECT id, status, verification_level, created_at FROM users
  WHERE role IN ('BUYER','SELLER') AND NOT (id = ANY(${excluded}::uuid[]))
)`;

// Local midnights are converted separately so short and long days count exactly once.
const bounds = `bounds AS (
  SELECT $1::date::timestamp AT TIME ZONE $3::text AS starts,
    ($2::date + 1)::timestamp AT TIME ZONE $3::text AS ends
)`;

const matches = `matches AS (
  SELECT m.id, m.type, m.source, m.chat_id, m.seller_id, m.buyer_id, m.created_at, m.proposed_at
  FROM listing_matches m JOIN participants seller ON seller.id = m.seller_id
  JOIN participants buyer ON buyer.id = m.buyer_id CROSS JOIN bounds
  WHERE m.created_at >= bounds.starts AND m.created_at < bounds.ends
)`;

// A reused chat can have messages that predate this introduction, even after a manual re-proposal.
const live = `live AS (
  SELECT greatest(firsts.seller_at, firsts.buyer_at) AS reached_at
  FROM matches m CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT min(created_at) FILTER (WHERE sender_id = m.seller_id) AS seller_at,
      min(created_at) FILTER (WHERE sender_id = m.buyer_id) AS buyer_at
    FROM chat_messages
    WHERE chat_id = m.chat_id AND sender_id IN (m.seller_id, m.buyer_id)
      AND created_at >= greatest(m.created_at, m.proposed_at) AND created_at < bounds.ends
  ) firsts
  WHERE m.chat_id IS NOT NULL AND firsts.seller_at IS NOT NULL AND firsts.buyer_at IS NOT NULL
)`;

type Levels = { level0: number; level1: number; level2: number };
type Visibility = {
  visibleSell: number; visibleBuy: number; hidden: number; participants: Levels;
};
export type PilotDay = {
  date: string;
  confirmed: number;
  visibleSell: number | null;
  visibleBuy: number | null;
  hidden: number | null;
  matches: number;
  matchesFull: number;
  matchesOperator: number;
  liveMatches: number;
  disclosures: number;
  agreementsFromDisclosures: number;
  dealsAgreed: number;
  dealsExecuted: number;
  asks: number;
  onTime: number;
  snapshot: 'SNAPSHOT' | 'LATE' | 'LIVE' | 'MISSING';
};

export async function readVisibility(client: Queryable, excluded: string[]): Promise<Visibility> {
  const { rows: [result] } = await client.query<Visibility>(`
    ${visibleCategories}, ${eligibleMembers('$1')}, visible_listings AS (
      SELECT l.kind, l.status, (${listingPublicWhere}) AS visible
      FROM listings l JOIN users u ON u.id = l.owner_id
      JOIN participants owner ON owner.id = l.owner_id
    )
    SELECT count(*) FILTER (WHERE visible AND kind='SELL')::int AS "visibleSell",
      count(*) FILTER (WHERE visible AND kind='BUY')::int AS "visibleBuy",
      count(*) FILTER (WHERE status='HIDDEN')::int AS hidden,
      (SELECT jsonb_build_object(
        'level0', count(*) FILTER (WHERE verification_level=0),
        'level1', count(*) FILTER (WHERE verification_level=1),
        'level2', count(*) FILTER (WHERE verification_level=2)
      ) FROM participants WHERE status='ACTIVE') AS participants
    FROM visible_listings
  `, [excluded]);
  return result;
}

export async function readPilotDays(client: Queryable, period: PilotPeriod, timezone: string, excluded: string[]) {
  const { rows } = await client.query<PilotDay>(`
    WITH ${bounds}, ${eligibleMembers('$4')}, ${matches}, ${live}, calendar AS (
      SELECT tick::date AS day FROM generate_series($1::date::timestamp, $2::date::timestamp, interval '1 day') tick
    ), confirmations AS (
      SELECT (a.answered_at AT TIME ZONE $3)::date AS day, count(DISTINCT a.listing_id)::int AS total
      FROM listing_actuality_asks a JOIN participants owner ON owner.id=a.owner_id CROSS JOIN bounds
      WHERE a.answered_at >= starts AND a.answered_at < ends AND a.answer IN ('ACTUAL','CHANGED','EDITED')
      GROUP BY 1
    ), match_days AS (
      SELECT (created_at AT TIME ZONE $3)::date AS day, count(*)::int AS total,
        count(*) FILTER (WHERE type='FULL')::int AS full,
        count(*) FILTER (WHERE source='OPERATOR')::int AS operator
      FROM matches GROUP BY 1
    ), live_days AS (
      SELECT (reached_at AT TIME ZONE $3)::date AS day, count(*)::int AS total FROM live GROUP BY 1
    ), disclosure_days AS (
      SELECT (d.accepted_at AT TIME ZONE $3)::date AS day, count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM deals t WHERE t.disclosure_id=d.id AND t.status IN ('AGREED','EXECUTED')
            AND t.seller_agreed IS NOT NULL AND t.buyer_agreed IS NOT NULL
        ))::int AS converted
      FROM disclosures d JOIN participants a ON a.id=d.user_a_id JOIN participants b ON b.id=d.user_b_id
      CROSS JOIN bounds
      WHERE d.kind='FIRST' AND d.accepted_at >= starts AND d.accepted_at < ends
      GROUP BY 1
    ), deal_days AS (
      SELECT (t.agreed_at AT TIME ZONE $3)::date AS day, count(*)::int AS total,
        count(*) FILTER (WHERE t.status='EXECUTED')::int AS executed
      FROM deals t JOIN participants s ON s.id=t.seller_id JOIN participants b ON b.id=t.buyer_id CROSS JOIN bounds
      WHERE t.status IN ('AGREED','EXECUTED') AND t.agreed_at >= starts AND t.agreed_at < ends
      GROUP BY 1
    ), ask_days AS (
      SELECT (a.asked_at AT TIME ZONE $3)::date AS day, count(*)::int AS total,
        count(*) FILTER (WHERE a.on_time IS TRUE)::int AS ontime
      FROM listing_actuality_asks a JOIN participants owner ON owner.id=a.owner_id CROSS JOIN bounds
      WHERE a.asked_at >= starts AND a.asked_at < ends AND (a.answered_at IS NOT NULL OR a.missed_at IS NOT NULL)
      GROUP BY 1
    )
    SELECT c.day::text AS date, coalesce(a.total,0) AS confirmed,
      s.listings_visible_sell AS "visibleSell", s.listings_visible_buy AS "visibleBuy", s.listings_hidden AS hidden,
      coalesce(m.total,0) AS matches, coalesce(m.full,0) AS "matchesFull", coalesce(m.operator,0) AS "matchesOperator",
      coalesce(l.total,0) AS "liveMatches", coalesce(d.total,0) AS disclosures,
      coalesce(d.converted,0) AS "agreementsFromDisclosures", coalesce(t.total,0) AS "dealsAgreed",
      coalesce(t.executed,0) AS "dealsExecuted", coalesce(q.total,0) AS asks, coalesce(q.ontime,0) AS "onTime",
      CASE WHEN s.local_date IS NULL THEN 'MISSING' WHEN s.late THEN 'LATE' ELSE 'SNAPSHOT' END AS snapshot
    FROM calendar c
    LEFT JOIN confirmations a USING (day)
    LEFT JOIN match_days m USING (day)
    LEFT JOIN live_days l USING (day)
    LEFT JOIN disclosure_days d USING (day)
    LEFT JOIN deal_days t USING (day)
    LEFT JOIN ask_days q USING (day)
    LEFT JOIN pilot_daily_snapshots s ON s.local_date=c.day
    ORDER BY c.day
  `, [period.from, period.to, timezone, excluded]);
  return rows;
}

export async function readLiveCount(client: Queryable, period: PilotPeriod, timezone: string, excluded: string[]) {
  const { rows: [row] } = await client.query<{ total: number }>(`
    WITH ${bounds}, ${eligibleMembers('$4')}, ${matches}, ${live} SELECT count(*)::int AS total FROM live
  `, [period.from, period.to, timezone, excluded]);
  return row.total;
}

export async function readParticipants(client: Queryable, period: PilotPeriod, timezone: string, excluded: string[]) {
  const demoInvites = demoMode() ? [
    '00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000002',
    '00000000-0000-4000-9000-000000000003',
  ] : [];
  const { rows: [result] } = await client.query<{ registered: number; invitesIssued: number; invitesUsed: number }>(`
    WITH ${bounds}, ${eligibleMembers('$4')}
    SELECT (SELECT count(*)::int FROM participants p WHERE p.created_at >= starts AND p.created_at < ends) AS registered,
      count(*) FILTER (WHERE i.created_at >= starts AND i.created_at < ends)::int AS "invitesIssued",
      count(*) FILTER (WHERE i.used_at >= starts AND i.used_at < ends)::int AS "invitesUsed"
    FROM bounds LEFT JOIN invites i ON NOT (i.id = ANY($5::uuid[]))
      AND (i.used_by IS NULL OR EXISTS (SELECT 1 FROM participants WHERE participants.id=i.used_by))
    GROUP BY starts, ends
  `, [period.from, period.to, timezone, excluded, demoInvites]);
  return result;
}
