import { ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { DatabaseService } from '../database/database.service'
import { ExchangeJobs } from './jobs'
import { PlatformSettings } from './platform-settings'
import { countEligibleDeals, listingLimit, participantRating } from './trust-score'
import { verificationLevelName } from './verification-requirements'

type RatingUser = {
  id: string; verification_level: number; role: string; status: string; representation_mode: string
  trust_score: number | null; agent_fee_banned_until: Date | null; link_group: string | null
  agent_fee_disclosed: boolean | null; agent_fee_confirmed_at: Date | null
}

type RatingMetrics = {
  age_days: number; age_months: number; on_time: number; asks: number; speed_hours: number | null
  principals_confirmed: boolean; lost: number; penalties: number
}


@Injectable()
export class TrustService implements OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs,
  ) {}

  onApplicationBootstrap() {
    this.jobs.register({
      name: 'trust.recompute', lock: 14, enabled: () => this.settings.enabled('feature_trust_rating'), slot: clock => clock.day + ':' + clock.hour,
      run: async (client, clock) => {
        if (!await this.settings.enabled('feature_trust_rating', client)) return { users: 0 }
        let after: string | null = null
        let users = 0
        for (;;) {
          const result: { rows: { id: string }[] } = await client.query<{ id: string }>(`
            SELECT id FROM users WHERE role IN ('BUYER','SELLER') AND status IN ('ACTIVE','BANNED')
              AND ($1::uuid IS NULL OR id > $1)
            ORDER BY id LIMIT 500
          `, [after])
          if (!result.rows.length) return { users }
          for (const row of result.rows) await this.recompute(client, row.id, clock.timezone)
          users += result.rows.length
          after = result.rows.at(-1)!.id
        }
      },
    })
  }

  async requireEnabled(client?: PoolClient) {
    if (!await this.settings.enabled('feature_trust_rating', client)) {
      throw new NotFoundException('Проверка и рейтинг пока недоступны')
    }
  }

  async assertPublishable(client: PoolClient, userId: string, { creating }: { creating: boolean }) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return

    // Concurrent publication requests must use the same used-listing count.
    const { rows: [user] } = await client.query<{
      verification_level: number; trust_score: number | null; publish_ban_at: Date | null
    }>(`
      SELECT verification_level, trust_score, publish_ban_at FROM users WHERE id = $1 FOR UPDATE
    `, [userId])
    if (!user) throw new NotFoundException('Пользователь не найден')
    if (user.publish_ban_at) throw new ForbiddenException('Публикация закрыта модератором до проверки документов')
    const limit = listingLimit(user.verification_level, user.trust_score)
    if (!creating || limit === null) return
    const used = await this.listingUse(client, userId)
    if (used >= limit) {
      throw new ConflictException(`Достигнут лимит объявлений — ${limit}.`)
    }
  }

  async refresh(client: PoolClient, userId: string) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return undefined
    const timezone = await this.settings.get<string>('timezone', client)
    return this.recompute(client, userId, timezone)
  }

  async summary(userId: string) {
    await this.requireEnabled()
    return this.db.transaction(async client => {
      const timezone = await this.settings.get<string>('timezone', client)
      const rating = await this.recompute(client, userId, timezone)
      if (!rating) throw new NotFoundException('Профиль не найден')
      const { rows: penalties } = await client.query(`
        SELECT id::text, kind, points, reason, created_at AS "createdAt" FROM user_penalties
        WHERE user_id = $1 AND created_at >= now() - interval '365 days' ORDER BY created_at DESC, id DESC
      `, [userId])
      const { rows: [user] } = await client.query(`
        SELECT verification_requested_at AS "verificationRequestedAt", verified_at AS "verifiedAt",
          verification_rejected_at AS "verificationRejectedAt", verification_note AS "verificationNote",
          publish_ban_at AS "publishBanAt", publish_ban_note AS "publishBanNote", verification_source AS source
        FROM users WHERE id = $1
      `, [userId])
      const { rows: dayCodes } = await client.query(`
        SELECT id, listing_id AS "listingId", code, spot_check AS "spotCheck", issued_at AS "issuedAt", expires_at AS "expiresAt"
        FROM day_codes WHERE user_id = $1 AND expires_at > now() AND result IS DISTINCT FROM 'FAILED'
        ORDER BY issued_at DESC LIMIT 30
      `, [userId])
      return {
        ...rating, penalties, dayCodes, ...user, levelName: verificationLevelName(rating.level, user.source),
        listingLimit: listingLimit(rating.level, rating.total), listingsUsed: await this.listingUse(client, userId),
      }
    })
  }

  private async listingUse(client: PoolClient, userId: string) {
    const { rows: [value] } = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM listings WHERE owner_id = $1 AND status IN ('ACTIVE','HIDDEN','PENDING_REVIEW')
    `, [userId])
    return value.count
  }

  private async recompute(client: PoolClient, userId: string, timezone: string) {
    const { rows: [user] } = await client.query<RatingUser>(`
      SELECT id, verification_level, role, status, representation_mode, trust_score, agent_fee_banned_until,
        agent_fee_disclosed, agent_fee_confirmed_at, link_group
      FROM users WHERE id = $1 AND role IN ('BUYER','SELLER') FOR UPDATE
    `, [userId])
    if (!user) return undefined

    const disputes = await this.settings.enabled('feature_disputes', client)
    const { rows: [metrics] } = await client.query<RatingMetrics>(`
      WITH response_times AS (
        SELECT seller_first_action_at AS acted_at, created_at FROM listing_matches WHERE seller_id = $1
        UNION ALL
        SELECT buyer_first_action_at, created_at FROM listing_matches WHERE buyer_id = $1
      )
      SELECT extract(epoch FROM now() - u.created_at)::float8 / 86400 AS age_days,
        (extract(year FROM age(now(), u.created_at)) * 12 + extract(month FROM age(now(), u.created_at)))::int AS age_months,
        (
          SELECT count(*)::int FROM listing_actuality_asks a
          WHERE a.owner_id = u.id AND a.asked_at >= now() - interval '30 days' AND a.on_time IS TRUE
        ) AS on_time,
        (
          SELECT count(*)::int FROM listing_actuality_asks a
          WHERE a.owner_id = u.id AND a.asked_at >= now() - interval '30 days'
            AND (a.answered_at IS NOT NULL OR a.missed_at IS NOT NULL)
        ) AS asks,
        (
          SELECT percentile_cont(.5) WITHIN GROUP (ORDER BY extract(epoch FROM acted_at - created_at) / 3600)
          FROM response_times WHERE acted_at >= created_at AND created_at >= now() - interval '90 days'
        ) AS speed_hours,
        (
          EXISTS (SELECT 1 FROM user_principals p WHERE p.user_id = u.id AND p.confirmed_at IS NOT NULL AND p.removed_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM listings l LEFT JOIN user_principals p ON p.id = l.principal_id
            WHERE l.owner_id = u.id AND l.representation = 'AGENT' AND l.status = 'ACTIVE'
              AND (p.confirmed_at IS NULL OR p.removed_at IS NOT NULL)
          )
        ) AS principals_confirmed,
        CASE WHEN $2 THEN (
          SELECT count(*)::int FROM dispute_decisions d WHERE d.loser_id=u.id AND d.penalty<>'NONE'
            AND d.decided_at>=now()-interval '365 days' AND NOT EXISTS (
              SELECT 1 FROM dispute_decisions later WHERE later.dispute_id=d.dispute_id AND later.round>d.round
            )
        ) ELSE (
          SELECT count(*)::int FROM reports r WHERE r.subject_id = u.id AND r.reason = 'FRAUD' AND r.status = 'RESOLVED'
            AND EXISTS (
              SELECT 1 FROM moderation_audit a WHERE a.entity = 'reports' AND a.entity_id = r.id::text
                AND a.action = 'status-changed' AND a.after_data->>'status' = 'RESOLVED'
                AND a.created_at >= now() - interval '365 days'
            )
        ) END AS lost,
        coalesce((SELECT sum(points)::int FROM user_penalties p
          WHERE p.user_id = u.id AND p.created_at >= now() - interval '365 days'), 0) AS penalties
      FROM users u WHERE u.id = $1
    `, [userId, disputes])

    const { rows: verified } = await client.query<{ counterparty: string; verified_at: Date }>(`
      SELECT other.id AS counterparty, d.admin_verified_at AS verified_at
      FROM deals d JOIN users other ON other.id = CASE WHEN d.seller_id = $1 THEN d.buyer_id ELSE d.seller_id END
      WHERE (d.seller_id = $1 OR d.buyer_id = $1) AND d.status = 'EXECUTED'
        AND d.admin_verified_at IS NOT NULL AND d.seller_executed_at IS NOT NULL AND d.buyer_executed_at IS NOT NULL
        AND ($2::text IS NULL OR other.link_group IS DISTINCT FROM $2)
      ORDER BY d.admin_verified_at, d.id
    `, [userId, user.link_group])
    const deals = countEligibleDeals(verified)
    const direct = user.representation_mode === 'DIRECT'
    const fees = !user.agent_fee_disclosed || (user.agent_fee_banned_until?.getTime() ?? 0) > Date.now()
      ? 'NONE' : user.agent_fee_confirmed_at ? 'CONFIRMED' : 'DISCLOSED'
    const rating = participantRating({
      level: user.verification_level, deals, ageDays: metrics.age_days, ageMonths: metrics.age_months,
      onTime: metrics.on_time, totalAnswers: metrics.asks, speedHours: metrics.speed_hours,
      direct, principalsConfirmed: metrics.principals_confirmed, lostDisputes: metrics.lost,
      agentFee: fees, penalties: metrics.penalties, banned: user.status === 'BANNED',
    })
    await client.query(`
      UPDATE users SET trust_score = $2, trust_factors = $3::jsonb, trust_updated_at = now(), verified_deals_count = $4
      WHERE id = $1
    `, [userId, rating.total, JSON.stringify(rating.factors), deals])
    await this.updateListings(client, userId, rating.total, timezone)
    return { ...rating, level: user.verification_level, deals }
  }

  private async updateListings(client: PoolClient, userId: string, score: number, timezone: string) {
    // Corridor values are only read within this query. Stored factors contain no
    // amount, midpoint, price boundary or implicit estimate.
    await client.query(`
      WITH wanted_models AS (
        SELECT DISTINCT model_id FROM listings WHERE owner_id = $1 AND model_id IS NOT NULL
      ), market_prices AS MATERIALIZED (
        SELECT l.id, l.model_id, l.delivery_included, l.price * fx.usd_per_unit AS usd
        FROM wanted_models w JOIN listings l USING (model_id)
          JOIN users u ON u.id = l.owner_id JOIN fx_rates fx ON fx.currency = l.currency
        WHERE l.kind = 'SELL' AND l.status = 'ACTIVE' AND u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL
          AND l.confirmed_at >= now() - interval '14 days' AND (l.expires_at IS NULL OR l.expires_at > now())
          AND l.price_mode = 'FIXED' AND l.price > 0 AND fx.usd_per_unit > 0
      ), market AS (
        SELECT model_id, delivery_included,
          percentile_cont(.5) WITHIN GROUP (ORDER BY usd)::numeric AS middle
        FROM market_prices GROUP BY model_id, delivery_included HAVING count(*) >= 5
      ), corridors AS (
        SELECT l.id, l.price * fx.usd_per_unit AS usd, l.confirmed_at,
          coalesce(peers.middle * .9, m.middle * .9, p.min_usd, fallback.middle * .9 * 1.06, warehouse.min_usd * 1.06) AS low,
          coalesce(peers.middle * 1.1, m.middle * 1.1, p.max_usd, fallback.middle * 1.1 * 1.06, warehouse.max_usd * 1.06) AS high,
          CASE WHEN cardinality(c.attribute_keys) = 0 THEN 0 ELSE
            (SELECT count(*) FROM unnest(c.attribute_keys) AS attr(key)
              WHERE length(btrim(coalesce(l.specs->>attr.key, ''))) > 0)::numeric * 10 / cardinality(c.attribute_keys)
          END + CASE WHEN l.proof_status = 'VERIFIED'
            AND l.proof_verified_at >= now() - CASE WHEN l.kind = 'SELL' THEN interval '14 days' ELSE interval '30 days' END
            THEN 10 ELSE 0 END AS completeness
        FROM listings l JOIN categories c ON c.id = l.category_id
          LEFT JOIN fx_rates fx ON fx.currency = l.currency
          LEFT JOIN market m ON m.model_id = l.model_id AND m.delivery_included = l.delivery_included
          -- When five other offers exist, a listing cannot shift its own benchmark.
          LEFT JOIN LATERAL (
            SELECT percentile_cont(.5) WITHIN GROUP (ORDER BY peer.usd)::numeric AS middle
            FROM market_prices peer WHERE peer.model_id = l.model_id AND peer.delivery_included = l.delivery_included
              AND peer.id <> l.id HAVING count(*) >= 5
          ) peers ON l.kind = 'SELL' AND m.middle IS NOT NULL
          LEFT JOIN price_corridors p ON p.model_id = l.model_id
            AND p.basis = CASE WHEN l.delivery_included THEN 'DELIVERED' ELSE 'SELLER_WAREHOUSE' END
          LEFT JOIN market fallback ON l.delivery_included AND fallback.model_id = l.model_id AND NOT fallback.delivery_included
          LEFT JOIN price_corridors warehouse ON l.delivery_included AND warehouse.model_id = l.model_id AND warehouse.basis = 'SELLER_WAREHOUSE'
        WHERE l.owner_id = $1
      ), factors AS (
        SELECT id, round($2::numeric * .4, 1) AS participant,
          CASE WHEN (confirmed_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date THEN 20
            WHEN confirmed_at >= now() - interval '24 hours' THEN 12 ELSE 0 END AS freshness,
          CASE WHEN usd IS NULL OR low IS NULL THEN NULL
               WHEN usd < low THEN (low - usd) / low WHEN usd > high THEN (usd - high) / high ELSE 0 END AS deviation,
          round(completeness, 1) AS completeness
        FROM corridors
      ), points AS (
        SELECT *, CASE WHEN deviation IS NULL THEN 10 WHEN deviation <= .15 THEN 20 WHEN deviation <= .30 THEN 10 ELSE 0 END AS price
        FROM factors
      )
      UPDATE listings l SET trust_score = greatest(0, least(100, round(p.participant + p.freshness + p.price + p.completeness)))::smallint,
        trust_factors = jsonb_build_object('participant', p.participant, 'freshness', p.freshness,
          'price', p.price, 'completeness', p.completeness),
        corridor_outside = coalesce(p.deviation > .30, false), trust_updated_at = now()
      FROM points p WHERE l.id = p.id
    `, [userId, score, timezone])
  }
}
