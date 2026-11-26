import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { SessionUser, StaffSession } from '../auth/auth.types'
import { withoutLegacyListingContacts, type PublicListingText } from '../contact-guard/public-text'
import { DatabaseService, type Queryable } from '../database/database.service'
import { auditExchange } from '../exchange/audit'
import { ExchangeNotifications } from '../exchange/notifications'
import { PlatformSettings } from '../exchange/platform-settings'
import { lockTrustStaff } from '../exchange/trust-access'
import { boolean, object, oneOf, pageParams, str, uuid } from '../market/market.inputs'
import { listingColumnsFor, listingJoins, listingPublicWhere, visibleCategories } from '../market/market.queries'
import { MatchingService } from '../matching/matching.service'
import { LotDetection, lotLock, lotPrimaryState } from './lot-detection'
import { lotGroupsEnabledSql } from './lot-public'
import { lotResolutions, recommendLotPrimary, type PrincipalEvidence } from './lot-rules'

const groupStatuses = ['OPEN', 'RESOLVED', 'DISSOLVED'] as const
const listingHref = '/my-listings'

type Group = {
  id: string; number: string; modelId: string; modelName: string; lotKey: string
  status: typeof groupStatuses[number]; primaryListingId: string | null
  sharedPrincipal: boolean | null; principalOwnerListingId: string | null
  resolution: string | null; resolutionNote: string | null
}
type Member = PrincipalEvidence & {
  groupId: string; title: string; nickname: string; quantity: number; city: string | null
  country: string | null; price: number; currency: string; pricePerUnit: number | null
  principalId: string | null; principalName: string | null; principalCompany: string | null
  confirmedVia: string | null; listingConfirmedAt: Date | null; trustScore: number | null
  requestId: string | null; answeredAt: Date | null; requestNote: string | null
  mandateDocumentId: string | null; mandateFileName: string | null; hiddenReason: string | null
  appealReason: string | null; appealAt: Date | null
}
const groupColumns = `g.id,g.number,g.model_id AS "modelId",h.name_ru AS "modelName",g.lot_key AS "lotKey",
  g.status,g.primary_listing_id AS "primaryListingId",g.shared_principal AS "sharedPrincipal",
  g.principal_owner_listing_id AS "principalOwnerListingId",g.resolution,g.resolution_note AS "resolutionNote",
  g.created_at AS "createdAt",g.resolved_at AS "resolvedAt"`

@Injectable()
export class LotGroupsService {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications, private readonly detector: LotDetection,
    private readonly matching: MatchingService) {}

  async publicMembers(actor: SessionUser, listingId: string) {
    if (actor.role !== 'BUYER') throw new NotFoundException('Лот не найден')
    const id = uuid(listingId)
    const { rows } = await this.db.query<PublicListingText & { privateFields?: unknown } & Record<string, unknown>>(`
      ${visibleCategories}, source AS (
        SELECT g.id,g.lot_key,l.owner_id FROM lot_group_members m
        JOIN lot_groups g ON g.id=m.group_id AND g.status='OPEN'
        JOIN listings l ON l.id=m.listing_id AND g.lot_key=l.lot_key
        JOIN users u ON u.id=l.owner_id
        WHERE m.listing_id=$1 AND m.role='MEMBER' AND ${listingPublicWhere} AND ${lotGroupsEnabledSql}
      ), alternatives AS (
        SELECT DISTINCT ON (l.owner_id) l.id
        FROM listings l JOIN users u ON u.id=l.owner_id
        JOIN lot_group_members m ON m.listing_id=l.id AND m.role='MEMBER'
        JOIN source g ON g.id=m.group_id AND g.lot_key=l.lot_key
        WHERE l.owner_id<>g.owner_id AND ${listingPublicWhere}
        ORDER BY l.owner_id,l.trust_score DESC NULLS LAST,l.created_at,l.id
      )
      SELECT ${listingColumnsFor()} ${listingJoins} JOIN alternatives a ON a.id=l.id
      ORDER BY l.trust_score DESC NULLS LAST,l.created_at,l.id
    `, [id])
    if (!rows.length) throw new NotFoundException('Лот не найден')
    const maskLegacyContacts = await this.settings.enabled('feature_disclosure_journal')
    // Public projections carry no owner-only privateFields marker.
    return { items: rows.map(({ privateFields: _private, ...row }) => maskLegacyContacts ? withoutLegacyListingContacts(row) : row) }
  }

  async list(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query)
    const status = query.status === undefined || query.status === '' ? null : oneOf(query.status, groupStatuses, 'Статус')
    const [groups, count] = await Promise.all([
      this.db.query<Group>(`
        SELECT ${groupColumns} FROM lot_groups g JOIN hardware_models h ON h.id=g.model_id
        WHERE ($1::text IS NULL OR g.status=$1) ORDER BY g.number DESC LIMIT $2 OFFSET $3
      `, [status, limit, offset]),
      this.db.query<{ total: number }>("SELECT count(*)::int AS total FROM lot_groups WHERE ($1::text IS NULL OR status=$1)", [status]),
    ])
    const members = await this.members(this.db, groups.rows.map(group => group.id))
    return { items: groups.rows.map(group => this.view(group, members.filter(member => member.groupId === group.id))),
      total: count.rows[0].total, page, limit }
  }

  async detail(id: string, db: Queryable = this.db) {
    const group = await this.group(db, uuid(id), false)
    return this.view(group, await this.members(db, [group.id]))
  }

  async myRequests(actor: SessionUser) {
    if (actor.role !== 'SELLER' || !await this.settings.enabled('feature_lot_groups')) return { items: [] }
    const { rows } = await this.db.query(`
      SELECT r.id,r.listing_id AS "listingId",r.asked_at AS "askedAt",l.title,
        l.principal_id AS "principalId",p.name AS "principalName"
      FROM lot_principal_requests r JOIN lot_groups g ON g.id=r.group_id AND g.status='OPEN'
      JOIN lot_group_members m ON m.group_id=r.group_id AND m.listing_id=r.listing_id AND m.role='MEMBER'
      JOIN listings l ON l.id=r.listing_id AND l.representation='AGENT' AND l.lot_key=g.lot_key
      LEFT JOIN user_principals p ON p.id=l.principal_id
      WHERE r.agent_id=$1 AND l.owner_id=$1 AND r.answered_at IS NULL ORDER BY r.asked_at DESC
    `, [actor.id])
    return { items: rows }
  }

  async answer(actor: SessionUser, id: string, raw: unknown) {
    if (actor.role !== 'SELLER') throw new NotFoundException('Запрос не найден')
    const data = object(raw)
    const name = str(data.principalLegalName, 'Юридическое наименование', 2, 200)
    const exclusive = boolean(data.exclusiveMandate, 'Эксклюзивный мандат')
    const documentId = data.mandateDocumentId ? uuid(data.mandateDocumentId, 'Мандат') : null
    const note = data.note == null || data.note === '' ? null : str(data.note, 'Комментарий', 1, 1000)
    return this.db.transaction(async client => {
      await this.lock(client)
      if (!await this.settings.enabled('feature_lot_groups', client)) throw new NotFoundException('Запрос не найден')
      const { rows: [request] } = await client.query<{ listing_id: string; answered_at: Date | null; principal_id: string | null }>(`
        SELECT r.listing_id,r.answered_at,l.principal_id
        FROM lot_principal_requests r JOIN lot_groups g ON g.id=r.group_id AND g.status='OPEN'
        JOIN lot_group_members m ON m.group_id=r.group_id AND m.listing_id=r.listing_id AND m.role='MEMBER'
        JOIN listings l ON l.id=r.listing_id AND l.owner_id=r.agent_id AND l.representation='AGENT' AND l.lot_key=g.lot_key
        WHERE r.id=$1 AND r.agent_id=$2 FOR UPDATE OF r
      `, [uuid(id), actor.id])
      if (!request) throw new NotFoundException('Запрос не найден')
      if (request.answered_at) throw new ConflictException('Ответ уже отправлен.')
      if (documentId && !(await client.query(`
        SELECT 1 FROM verification_documents WHERE id=$1 AND user_id=$2 AND listing_id=$3 AND kind='MANDATE'
          AND principal_id=$4
      `, [documentId, actor.id, request.listing_id, request.principal_id])).rowCount) {
        throw new BadRequestException('Выберите мандат, загруженный для этого объявления и принципала.')
      }
      const { rows: [answered] } = await client.query(`
        UPDATE lot_principal_requests SET answered_at=now(),principal_legal_name=$2,exclusive_mandate=$3,
          mandate_document_id=$4,note=$5 WHERE id=$1
        RETURNING id,listing_id AS "listingId",answered_at AS "answeredAt",principal_legal_name AS "principalLegalName",
          exclusive_mandate AS "exclusiveMandate",mandate_document_id AS "mandateDocumentId",note
      `, [uuid(id), name, exclusive, documentId, note])
      return answered
    })
  }

  appeal(actor: SessionUser, id: string, raw: unknown) {
    const reason = str(object(raw).reason, 'Причина', 10, 1000)
    const listingId = uuid(id)
    return this.db.transaction(async client => {
      await this.lock(client)
      const { rows: [listing] } = await client.query<{ group_id: string | null; number: string | null }>(`
        SELECT g.id AS group_id,g.number FROM listings l
        LEFT JOIN lot_group_members m ON m.listing_id=l.id AND m.role='DUPLICATE'
        LEFT JOIN lot_groups g ON g.id=m.group_id AND g.status='RESOLVED' AND g.primary_listing_id=l.duplicate_of
        WHERE l.id=$1 AND l.owner_id=$2 FOR SHARE OF l
      `, [listingId, actor.id])
      if (!listing) throw new NotFoundException('Объявление не найдено')
      if (!listing.group_id) throw new ConflictException('Объявление не помечено как дубль.')
      const { rows: [appeal] } = await client.query<{ id: string }>(`
        INSERT INTO lot_duplicate_appeals(group_id,listing_id,owner_id,reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT (listing_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id
      `, [listing.group_id, listingId, actor.id, reason])
      if (!appeal) throw new ConflictException('Оспаривание уже ожидает рассмотрения.')
      await this.detector.staffNotice(client, listing.group_id, 'lot.appeal', 'Оспаривание дубля',
        `Владелец оспаривает дубль в группе ${listing.number}`, 'lot.appeal:' + appeal.id)
      return { ok: true }
    })
  }

  requestPrincipals(actor: StaffSession, id: string) {
    return this.staffChange(actor, id, 'OPEN', async (client, group) => {
      const { rows: requests } = await client.query<{ id: string; agent_id: string; title: string }>(`
        WITH inserted AS (
          INSERT INTO lot_principal_requests(group_id,listing_id,agent_id,asked_by)
          SELECT m.group_id,m.listing_id,m.owner_id,$2 FROM lot_group_members m
          JOIN listings l ON l.id=m.listing_id AND l.lot_key=$3
          JOIN users u ON u.id=l.owner_id AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL
          WHERE m.group_id=$1 AND m.role='MEMBER' AND l.representation='AGENT'
          ON CONFLICT (group_id,listing_id) DO NOTHING RETURNING id,listing_id,agent_id
        )
        SELECT r.id,r.agent_id,l.title FROM inserted r JOIN listings l ON l.id=r.listing_id
      `, [group.id, actor.id, group.lotKey])
      for (const request of requests) await this.notifications.notify(client, request.agent_id, {
        kind: 'lot.principal_request', title: 'Уточнение принципала',
        body: `Модератор уточняет лот «${request.title}». Конфиденциально укажите юрлицо принципала и есть ли у вас эксклюзивный мандат. Ответ видит только модератор.`,
        channels: ['EMAIL', 'TELEGRAM'], dedupeKey: 'lot.principal_request:' + request.id,
        actions: [{ label: 'Ответить модератору', href: listingHref + '?lotRequest=' + request.id }],
      })
      await auditExchange(client, actor, 'lot_groups', group.id, 'principal-requested', null, { created: requests.length })
      return { created: requests.length }
    })
  }

  sharedPrincipal(actor: StaffSession, id: string, raw: unknown) {
    const data = object(raw)
    const shared = boolean(data.shared, 'Общий принципал')
    const owner = shared && data.principalOwnerListingId ? uuid(data.principalOwnerListingId, 'Карточка принципала') : null
    return this.staffChange(actor, id, 'OPEN', async (client, group) => {
      if (owner && !(await client.query(`
        SELECT 1 FROM lot_group_members m JOIN listings l ON l.id=m.listing_id
        WHERE m.group_id=$1 AND m.listing_id=$2 AND m.role='MEMBER' AND l.representation='DIRECT'
          AND l.status='ACTIVE' AND l.lot_key=$3
      `, [group.id, owner, group.lotKey])).rowCount) throw new BadRequestException('Выберите активную карточку прямого участника группы.')
      await client.query('UPDATE lot_groups SET shared_principal=$2,principal_owner_listing_id=$3 WHERE id=$1', [group.id, shared, owner])
      await auditExchange(client, actor, 'lot_groups', group.id, 'principal-marked', { shared: group.sharedPrincipal }, { shared, owner })
      return this.detail(group.id, client)
    })
  }

  resolve(actor: StaffSession, id: string, raw: unknown) {
    const data = object(raw)
    const primary = uuid(data.primaryListingId, 'Главная карточка')
    const resolution = oneOf(data.resolution, lotResolutions, 'Решение')
    const note = data.note == null || data.note === '' ? null : str(data.note, 'Комментарий', 1, 1000)
    return this.staffChange(actor, id, 'OPEN', async (client, group) => {
      const locked = await client.query<{
        id: string; status: string; hidden_reason: string | null; title: string; owner_id: string; lot_key: string | null
      }>(`
        SELECT l.id,l.status,l.hidden_reason,l.title,l.owner_id,l.lot_key FROM lot_group_members m
        JOIN listings l ON l.id=m.listing_id WHERE m.group_id=$1 AND m.role='MEMBER' ORDER BY l.id FOR UPDATE OF l
      `, [group.id])
      if (!locked.rows.some(row => row.id === primary && row.status === 'ACTIVE')) {
        throw new BadRequestException('Главная карточка должна быть активным объявлением группы.')
      }
      if (locked.rows.length < 2 || locked.rows.some(row => row.lot_key !== group.lotKey ||
        (row.status !== 'ACTIVE' && !(row.status === 'HIDDEN' && row.hidden_reason === 'PAUSE'))) ||
        !await this.detector.coherent(client, group.lotKey, locked.rows.map(row => row.id))) {
        throw new ConflictException('Состав группы изменился. Откройте её после пересчёта.')
      }
      const recommendation = recommendLotPrimary(await this.members(client, [group.id]),
        group.sharedPrincipal, group.principalOwnerListingId)
      if (resolution === 'OPERATOR' ? !note : recommendation?.listingId !== primary || recommendation.resolution !== resolution) {
        throw new BadRequestException('Если выбор отличается от рекомендации, укажите решение модератора и причину.')
      }
      await client.query(`
        UPDATE lot_groups g SET status='RESOLVED',primary_listing_id=$2,primary_state=${lotPrimaryState},
          resolution=$3,resolution_note=$4,resolved_by=$5,resolved_at=now() FROM listings l WHERE g.id=$1 AND l.id=$2
      `, [group.id, primary, resolution, note, actor.id])
      await client.query(`
        UPDATE lot_group_members SET role=CASE WHEN listing_id=$2 THEN 'PRIMARY' ELSE 'DUPLICATE' END
        WHERE group_id=$1 AND role='MEMBER'
      `, [group.id, primary])
      const duplicates = locked.rows.filter(row => row.id !== primary)
      await client.query(`
        UPDATE listings SET status='HIDDEN',hidden_reason='DUPLICATE',hidden_at=now(),duplicate_of=$2,updated_at=now()
        WHERE id=ANY($1::uuid[])
      `, [duplicates.map(row => row.id), primary])
      for (const row of duplicates) {
        await this.notifications.notify(client, row.owner_id, {
          kind: 'lot.hidden_duplicate', title: 'Объявление помечено как дубль',
          body: `Объявление «${row.title}» помечено как дубль лота, который уже есть на площадке, и скрыто из каталога. Если это ошибка, оспорьте решение.`,
          channels: ['EMAIL'], dedupeKey: 'lot.hidden_duplicate:' + group.id + ':' + row.id,
          actions: [{ label: 'Мои объявления', href: listingHref }],
        })
        await this.matching.recomputeListing(client, row.id)
      }
      await auditExchange(client, actor, 'lot_groups', group.id, 'resolved', { status: group.status }, { primary, resolution }, note)
      return this.detail(group.id, client)
    })
  }

  dissolve(actor: StaffSession, id: string, raw: unknown) {
    const note = str(object(raw).note, 'Причина', 1, 1000)
    return this.staffChange(actor, id, 'OPEN', async (client, group) => {
      await client.query(`
        INSERT INTO lot_group_exclusions(listing_a,listing_b,created_by)
        SELECT a.listing_id,b.listing_id,$2 FROM lot_group_members a JOIN lot_group_members b
          ON b.group_id=a.group_id AND a.listing_id<b.listing_id
        WHERE a.group_id=$1 AND a.role='MEMBER' AND b.role='MEMBER' ON CONFLICT DO NOTHING
      `, [group.id, actor.id])
      await client.query("UPDATE lot_group_members SET role='REMOVED' WHERE group_id=$1 AND role='MEMBER'", [group.id])
      await client.query(`
        UPDATE lot_groups SET status='DISSOLVED',resolution='DIFFERENT_LOTS',resolution_note=$2,resolved_by=$3,
          resolved_at=now() WHERE id=$1
      `, [group.id, note, actor.id])
      await auditExchange(client, actor, 'lot_groups', group.id, 'dissolved', { status: group.status }, { resolution: 'DIFFERENT_LOTS' }, note)
      return this.detail(group.id, client)
    })
  }

  restore(actor: StaffSession, id: string, listingIdInput: string, raw: unknown) {
    const listingId = uuid(listingIdInput)
    const note = str(object(raw).note, 'Причина', 1, 1000)
    return this.staffChange(actor, id, 'RESOLVED', async (client, group) => {
      const { rows: [member] } = await client.query<{
        owner_id: string; status: string; hidden_reason: string | null; spot_check_hold: boolean; owner_active: boolean
      }>(`
        SELECT l.owner_id,l.status,l.hidden_reason,l.spot_check_hold,
          u.status='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.publish_ban_at IS NULL AS owner_active
        FROM lot_group_members m JOIN listings l ON l.id=m.listing_id JOIN users u ON u.id=l.owner_id
        WHERE m.group_id=$1 AND m.listing_id=$2 AND m.role='DUPLICATE' AND l.duplicate_of=$3 FOR UPDATE OF l
      `, [group.id, listingId, group.primaryListingId])
      if (!member) throw new ConflictException('Объявление уже не является дублем этой группы.')
      if (!member.owner_active || member.spot_check_hold ||
        !(member.status === 'ARCHIVED' || (member.status === 'HIDDEN' && member.hidden_reason === 'DUPLICATE'))) {
        throw new ConflictException('Объявление ограничено другой мерой модерации.')
      }
      const { rows: [listing] } = await client.query<{ id: string; status: string; title: string }>(`
        UPDATE listings SET status='ACTIVE',duplicate_of=NULL,confirmed_at=now(),
          expires_at=greatest(expires_at,now()+lifetime_days*interval '1 day'),updated_at=now()
        WHERE id=$1 RETURNING id,status,title
      `, [listingId])
      await client.query("UPDATE lot_group_members SET role='REMOVED' WHERE group_id=$1 AND listing_id=$2", [group.id, listing.id])
      await client.query(`
        INSERT INTO lot_group_exclusions(listing_a,listing_b,created_by)
        VALUES (least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),$3) ON CONFLICT DO NOTHING
      `, [listing.id, group.primaryListingId, actor.id])
      await client.query('UPDATE lot_duplicate_appeals SET resolved_at=now() WHERE listing_id=$1 AND resolved_at IS NULL', [listing.id])
      await this.notifications.notify(client, member.owner_id, {
        kind: 'lot.restored', title: 'Объявление возвращено', body: `Объявление «${listing.title}» снова в каталоге`,
        actions: [{ label: 'Мои объявления', href: listingHref }], dedupeKey: 'lot.restored:' + group.id + ':' + listing.id,
      })
      await this.matching.recomputeListing(client, listing.id)
      await auditExchange(client, actor, 'lot_groups', group.id, 'member-restored', { listingId, status: member.status }, { status: listing.status }, note)
      return listing
    })
  }

  private staffChange<T>(actor: StaffSession, id: string, status: Group['status'], change: (client: PoolClient, group: Group) => Promise<T>) {
    return this.db.transaction(async client => {
      await this.lock(client)
      await lockTrustStaff(client, actor)
      const group = await this.group(client, uuid(id), true)
      if (group.status !== status) throw new ConflictException('Статус группы уже изменился.')
      if (status === 'OPEN' && !await this.settings.enabled('feature_lot_groups', client)) {
        throw new ConflictException('Поиск похожих лотов сейчас выключен.')
      }
      return change(client, group)
    })
  }

  private lock(client: PoolClient) {
    return client.query('SELECT pg_advisory_xact_lock(18403,$1)', [lotLock])
  }

  private async group(client: Queryable, id: string, forUpdate: boolean) {
    const { rows: [group] } = await client.query<Group>(`
      SELECT ${groupColumns} FROM lot_groups g JOIN hardware_models h ON h.id=g.model_id
      WHERE g.id=$1 ${forUpdate ? 'FOR UPDATE OF g' : ''}
    `, [id])
    if (!group) throw new NotFoundException('Группа лотов не найдена')
    return group
  }

  private async members(client: Queryable, groups: string[]) {
    if (!groups.length) return []
    const { rows } = await client.query<Member>(`
      SELECT m.group_id AS "groupId",l.id AS "listingId",m.owner_id AS "ownerId",m.role AS "membershipRole",l.title,
        u.display_name AS nickname,u.company_name AS "ownerCompany",l.status AS "listingStatus",l.hidden_reason AS "hiddenReason",
        l.quantity,l.stock_city AS city,l.origin_country AS country,l.price::float8 AS price,l.currency,
        round(l.price/nullif(l.quantity,0),2)::float8 AS "pricePerUnit",
        l.representation,l.principal_id AS "principalId",p.name AS "principalName",p.company AS "principalCompany",
        CASE WHEN p.removed_at IS NULL THEN p.confirmed_at END AS "confirmedAt",p.confirmed_via AS "confirmedVia",
        CASE WHEN p.removed_at IS NULL THEN p.platform_user_id END AS "principalUserId",
        l.confirmed_at AS "listingConfirmedAt",l.trust_score AS "trustScore",
        r.id AS "requestId",r.answered_at AS "answeredAt",r.principal_legal_name AS "principalLegalName",
        r.exclusive_mandate AS "exclusiveMandate",r.note AS "requestNote",
        d.id AS "mandateDocumentId",d.file_name AS "mandateFileName",d.status AS "mandateStatus",
        a.reason AS "appealReason",a.created_at AS "appealAt"
      FROM lot_group_members m JOIN listings l ON l.id=m.listing_id JOIN users u ON u.id=m.owner_id
      LEFT JOIN user_principals p ON p.id=l.principal_id
      LEFT JOIN lot_principal_requests r ON r.group_id=m.group_id AND r.listing_id=m.listing_id
      LEFT JOIN verification_documents d ON d.id=r.mandate_document_id AND d.principal_id=l.principal_id
      LEFT JOIN lot_duplicate_appeals a ON a.group_id=m.group_id AND a.listing_id=m.listing_id AND a.resolved_at IS NULL
      WHERE m.group_id=ANY($1::uuid[]) ORDER BY m.joined_at,m.listing_id
    `, [groups])
    return rows
  }

  private view(group: Group, members: Member[]) {
    const { lotKey: _fingerprint, ...data } = group
    return {
      ...data, members, participants: new Set(members.filter(member => group.status === 'DISSOLVED' || member.membershipRole !== 'REMOVED')
        .map(member => member.ownerId)).size,
      recommendation: group.status === 'OPEN' ? recommendLotPrimary(members, group.sharedPrincipal, group.principalOwnerListingId) : null,
    }
  }
}
