import { Injectable, type OnModuleInit } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { ExchangeJobs, type ExchangeClock } from '../exchange/jobs'
import { ExchangeNotifications } from '../exchange/notifications'
import { PlatformSettings } from '../exchange/platform-settings'
import { listingPublicWhere, visibleCategories } from '../market/market.queries'
import { lotComponents, type LotOffer } from './lot-rules'

export const lotLock = 23
export const lotStaffHref = (groupId: string) => '/admin?section=exchange&part=lots&lot=' + groupId
export const lotPrimaryState = `jsonb_build_array(l.status,l.model_id,l.quantity,l.origin_scope,l.origin_country,
  l.stock_city,l.price_mode,l.price,l.currency,l.representation,l.principal_id)`

type OldMembership = { groupId: string; listingId: string }

@Injectable()
export class LotDetection implements OnModuleInit {
  constructor(private readonly jobs: ExchangeJobs, private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications) {}

  onModuleInit() {
    this.jobs.register({
      name: 'lots.detect', lock: lotLock, slot: clock => clock.day + 'T' + clock.hour,
      enabled: () => this.settings.enabled('feature_lot_groups'),
      run: async (client, clock) => {
        await client.query(`
          INSERT INTO lot_detection_pending(lot_key)
          SELECT DISTINCT lot_key FROM listings WHERE status='ACTIVE' AND lot_key IS NOT NULL
          UNION SELECT lot_key FROM lot_groups WHERE status='OPEN'
          ON CONFLICT (lot_key) DO NOTHING
        `)
        return this.pending(client, clock)
      },
    })
    this.jobs.register({
      name: 'lots.pending', lock: lotLock, enabled: () => this.settings.enabled('feature_lot_groups'),
      run: (client, clock) => this.pending(client, clock),
    })
  }

  async staffNotice(client: PoolClient, id: string, kind: string, title: string, body: string, dedupeKey?: string) {
    const { rows: staff } = await client.query<{ id: string }>(`
      SELECT id FROM users WHERE role IN ('ADMIN','MODERATOR') AND status='ACTIVE' ORDER BY id
    `)
    for (const user of staff) await this.notifications.notify(client, user.id, {
      kind, title, body, dedupeKey, actions: [{ label: 'Открыть группу', href: lotStaffHref(id) }],
    })
  }

  async coherent(client: PoolClient, key: string, listingIds: string[]) {
    const desired = new Set(listingIds)
    const offers = (await this.offers(client, key)).filter(offer => desired.has(offer.id))
    if (offers.length !== desired.size) return false
    const tolerance = await this.settings.get<number>('lot_price_tolerance', client)
    return (await this.components(client, offers, tolerance)).some(group => group.length === desired.size)
  }

  private async pending(client: PoolClient, _clock: ExchangeClock) {
    const { rows: work } = await client.query<{ lot_key: string; queued_at: string }>(`
      SELECT lot_key, queued_at::text FROM lot_detection_pending ORDER BY queued_at,lot_key LIMIT 500
    `)
    const tolerance = await this.settings.get<number>('lot_price_tolerance', client)
    let considered = 0, created = 0
    for (const entry of work) {
      const result = await this.reconcile(client, entry.lot_key, tolerance)
      await client.query('DELETE FROM lot_detection_pending WHERE lot_key=$1 AND queued_at=$2', [entry.lot_key, entry.queued_at])
      considered += Math.max(1, result.offers)
      created += result.created
      if (considered >= 500) break
    }
    await this.primaryChanges(client)
    return { considered, created }
  }

  private async offers(client: PoolClient, key: string) {
    const offers: LotOffer[] = []
    let previous: string | null = null
    // Page one fingerprint at a time so the complete transitive component is visible to the detector.
    for (;;) {
      const { rows: page }: { rows: LotOffer[] } = await client.query<LotOffer>(`
        ${visibleCategories}
        SELECT l.id,l.owner_id AS "ownerId",l.model_id AS "modelId",(l.price*f.usd_per_unit)::text AS "usdTotal"
        FROM listings l JOIN users u ON u.id=l.owner_id JOIN fx_rates f ON f.currency=l.currency
        JOIN hardware_models h ON h.id=l.model_id AND h.status='ACTIVE'
        LEFT JOIN lot_group_members lm ON lm.listing_id=l.id AND lm.role IN ('MEMBER','PRIMARY')
        LEFT JOIN lot_groups g ON g.id=lm.group_id
        WHERE l.lot_key=$1 AND ($2::uuid IS NULL OR l.id > $2)
          AND l.price_mode='FIXED' AND l.price IS NOT NULL AND f.usd_per_unit IS NOT NULL
          AND l.duplicate_of IS NULL AND lm.role IS DISTINCT FROM 'PRIMARY'
          AND ((${listingPublicWhere}) OR (l.status='HIDDEN' AND l.hidden_reason='PAUSE'
            AND u.status='ACTIVE' AND g.status='OPEN' AND g.lot_key=$1))
        ORDER BY l.id LIMIT 500
      `, [key, previous])
      offers.push(...page)
      if (page.length < 500) return offers
      previous = page[page.length - 1].id
    }
  }

  private async reconcile(client: PoolClient, key: string, tolerance: number) {
    const { rows: groups } = await client.query<{ id: string }>(
      "SELECT id FROM lot_groups WHERE lot_key=$1 AND status='OPEN' ORDER BY number", [key],
    )
    const { rows: old } = await client.query<OldMembership>(`
      SELECT m.group_id AS "groupId",m.listing_id AS "listingId" FROM lot_group_members m
      JOIN lot_groups g ON g.id=m.group_id WHERE g.lot_key=$1 AND g.status='OPEN' AND m.role='MEMBER'
    `, [key])
    const offers = await this.offers(client, key)
    if (!groups.length && offers.length < 2) return { created: 0, offers: offers.length }
    const existing = new Map(old.map(member => [member.listingId, member.groupId]))
    const retained = new Set<string>()
    const assigned: { groupId: string; members: LotOffer[]; created: boolean }[] = []
    for (const members of await this.components(client, offers, tolerance)) {
      const related = new Set(members.map(member => existing.get(member.id)))
      const previous = groups.find(group => related.has(group.id) && !retained.has(group.id))
      const groupId = previous?.id ?? (await client.query<{ id: string }>(`
        INSERT INTO lot_groups(lot_key,model_id) VALUES ($1,$2) RETURNING id
      `, [key, members[0].modelId])).rows[0].id
      retained.add(groupId)
      assigned.push({ groupId, members, created: !previous })
    }
    const desired = new Map(assigned.flatMap(group => group.members.map(member => [member.id, group.groupId] as const)))
    const leaving = old.filter(member => desired.get(member.listingId) !== member.groupId)
    const moved = leaving.filter(member => desired.has(member.listingId))
    if (moved.length) await client.query(`
      UPDATE lot_principal_requests r SET group_id=move.to_group
      FROM unnest($1::uuid[],$2::uuid[],$3::uuid[]) AS move(from_group,listing_id,to_group)
      WHERE r.group_id=move.from_group AND r.listing_id=move.listing_id AND NOT EXISTS (
        SELECT 1 FROM lot_principal_requests prior
        WHERE prior.group_id=move.to_group AND prior.listing_id=move.listing_id
      )
    `, [moved.map(member => member.groupId), moved.map(member => member.listingId),
      moved.map(member => desired.get(member.listingId)!)])
    if (leaving.length) await client.query(`
      UPDATE lot_group_members m SET role='REMOVED'
      FROM unnest($1::uuid[],$2::uuid[]) AS removed(group_id,listing_id)
      WHERE m.group_id=removed.group_id AND m.listing_id=removed.listing_id
    `, [leaving.map(member => member.groupId), leaving.map(member => member.listingId)])
    if (desired.size) await client.query(`
      UPDATE lot_group_members m SET role='REMOVED' FROM lot_groups g
      WHERE m.group_id=g.id AND g.status='OPEN'
        AND g.lot_key<>$2 AND m.role='MEMBER' AND m.listing_id=ANY($1::uuid[])
    `, [[...desired.keys()], key])
    const dissolved = groups.filter(group => !retained.has(group.id)).map(group => group.id)
    if (dissolved.length) await client.query(`
      UPDATE lot_groups SET status='DISSOLVED', resolved_at=now() WHERE id=ANY($1::uuid[])
    `, [dissolved])
    for (const group of assigned) {
      const joining = group.members.filter(member => existing.get(member.id) !== group.groupId)
      if (!group.created && (joining.length || leaving.some(member => member.groupId === group.groupId))) {
        // A moderator attested to the previous set of offers.
        await client.query('UPDATE lot_groups SET shared_principal=NULL,principal_owner_listing_id=NULL WHERE id=$1', [group.groupId])
      }
      if (joining.length) await client.query(`
        INSERT INTO lot_group_members(group_id,listing_id,owner_id)
        SELECT $1,id,owner FROM unnest($2::uuid[],$3::uuid[]) AS member(id,owner)
        ON CONFLICT(group_id,listing_id) DO UPDATE SET role='MEMBER', joined_at=now()
      `, [group.groupId, joining.map(member => member.id), joining.map(member => member.ownerId)])
      if (group.created) {
        const { rows: [sample] } = await client.query<{ model: string; quantity: number; city: string | null }>(`
          SELECT h.name_ru AS model,l.quantity,l.stock_city AS city
          FROM listings l JOIN hardware_models h ON h.id=l.model_id WHERE l.id=$1
        `, [group.members[0].id])
        const count = new Set(group.members.map(member => member.ownerId)).size
        await this.staffNotice(client, group.groupId, 'lot.created', 'Похожие предложения',
          `Похожие предложения: ${sample.model}, ${sample.quantity} шт${sample.city ? ', ' + sample.city : ''}. Участников: ${count}`)
      }
    }
    return { created: assigned.filter(group => group.created).length, offers: offers.length }
  }

  private async components(client: PoolClient, offers: LotOffer[], tolerance: number) {
    if (offers.length < 2) return []
    const { rows: exclusions } = await client.query<{ listingA: string; listingB: string }>(`
      SELECT listing_a AS "listingA",listing_b AS "listingB" FROM lot_group_exclusions
      WHERE listing_a=ANY($1::uuid[]) AND listing_b=ANY($1::uuid[])
    `, [offers.map(offer => offer.id)])
    return lotComponents(offers, exclusions, tolerance)
  }

  private async primaryChanges(client: PoolClient) {
    const { rows } = await client.query<{ id: string; number: string; status: string }>(`
      WITH changed AS (
        SELECT g.id,${lotPrimaryState} AS state,l.status FROM lot_groups g JOIN listings l ON l.id=g.primary_listing_id
        WHERE g.status='RESOLVED' AND g.primary_state IS DISTINCT FROM ${lotPrimaryState}
        ORDER BY g.number LIMIT 500
      )
      UPDATE lot_groups g SET primary_state=c.state FROM changed c WHERE g.id=c.id
      RETURNING g.id,g.number,c.status
    `)
    for (const row of rows) {
      const active = row.status === 'ACTIVE'
      await this.staffNotice(client, row.id, 'lot.primary_changed', 'Изменение главной карточки лота',
        `Главная карточка лота ${row.number} ${active ? 'изменилась' : 'снята'}`)
    }
  }
}
