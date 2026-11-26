import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common'
import type { SessionUser } from '../auth/auth.types'
import { publicListingTitle, publicNickname } from '../contact-guard/public-text'
import { DatabaseService, type Queryable } from '../database/database.service'
import { calendarDate, object, pageParams, Parameters, str, uuid } from '../market/market.inputs'
import { ExchangeActions } from './actions'
import { auditExchange } from './audit'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'

type Party = {
  userId: string
  nickname: string
  companyName: string | null
  participantType: string
  country: string
  telegram: string | null
}

type DisclosureRow = {
  id: string
  number: string
  kind: 'FIRST' | 'REPEAT'
  user_a_id: string
  user_b_id: string
  party_a: Party
  party_b: Party
  listing_snapshot: Record<string, unknown>
  counter_listing_snapshot: Record<string, unknown> | null
  accepted_at: Date
  requested_at: Date | null
  rules_version: string | null
  migrated: boolean
  chat_id: string
  match_id: string | null
  requested_by: string
  accepted_by: string
}

type DisclosureEvent = { type: string; actor_user_id: string | null; data: unknown; created_at: Date }

export function disclosureNumber(value: string | number) {
  return 'R-' + String(value).padStart(6, '0')
}

export const disclosureTerms = [
  'Контакты, полученные через раскрытие, используются только для переговоров по этой позиции и не передаются третьим лицам.',
  'Сделка с раскрытым собеседником в течение 12 месяцев по той же или аналогичной позиции считается сделкой, которую свела площадка.',
  'При споре вы передаёте модератору переписку по сделке.',
]

@Injectable()
export class DisclosuresService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications,
    private readonly actions: ExchangeActions,
  ) {}

  onModuleInit() {
    this.actions.register('disclosure.already_known', {
      describe: async () => ({ title: 'Отметить, что уже знакомы' }),
      execute: (client, token) => this.markAlreadyKnown(client, token.userId!, token.subjectId),
      lockSubjects: async (client, token) => {
        await client.query(`SELECT u.id FROM users u JOIN disclosures d ON u.id IN (d.user_a_id,d.user_b_id)
          WHERE d.id=$1 AND $2 IN (d.user_a_id,d.user_b_id) ORDER BY u.id FOR UPDATE OF u`, [token.subjectId, token.userId])
      },
    })
  }

  async assertRules(db: Queryable, actor: string, partner: string, accepted: unknown, requestedVersion?: string | null) {
    const min = await this.settings.get<number>('disclosure_min_level', db)
    if (accepted !== true) throw new BadRequestException('Подтвердите правила раскрытия')
    const current = await this.settings.get<string>('rules_version', db)
    if (requestedVersion !== undefined && requestedVersion !== current) {
      throw new ConflictException('Правила раскрытия обновились. Запросите обмен заново.')
    }
    if (min > 0) {
      const { rows } = await db.query<{ id: string; level: number }>(`
        SELECT id, coalesce((to_jsonb(u)->>'verification_level')::int, 0) AS level
        FROM users u WHERE id IN ($1, $2)
      `, [actor, partner])
      if ((rows.find(row => row.id === actor)?.level ?? 0) < min) {
        throw new ForbiddenException('Контакты раскрываются только после проверки документов. Загрузите документы в профиле.')
      }
      if ((rows.find(row => row.id === partner)?.level ?? 0) < min) {
        throw new ForbiddenException('Собеседник ещё не прошёл проверку документов')
      }
    }
    return current
  }

  async requestNotice(db: Queryable, actor: string, partner: string, chatId: string, requestId: string) {
    const { rows: [row] } = await db.query<{ nickname: string; title: string }>(`
      SELECT u.display_name AS nickname, l.title FROM chats c JOIN listings l ON l.id = c.listing_id
      JOIN users u ON u.id = $1 WHERE c.id = $2
    `, [actor, chatId])
    if (!row) return
    const token = await this.actions.issue(db, {
      purpose: 'chat.reveal', subjectId: chatId, userId: partner, payload: { requestId },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    await this.notifications.notify(db, partner, {
      kind: 'disclosure.request', title: 'Запрос обмена контактами',
      body: `${publicNickname(row.nickname)} предлагает обменяться контактами по объявлению «${publicListingTitle(row.title)}».`,
      actions: [{ label: 'Ответить на запрос', token, action: 'chat.reveal' }, { label: 'Открыть чат', href: '/chats/' + chatId, action: 'open' }],
      dedupeKey: 'disclosure.request:' + requestId, channels: ['EMAIL'],
    })
  }

  async create(db: Queryable, exchangeId: string, rulesVersion: string) {
    const { rows: [row] } = await db.query<DisclosureRow>(`
      INSERT INTO disclosures (
        user_a_id, user_b_id, exchange_id, chat_id, listing_id, counter_listing_id, match_id,
        kind, requested_by, accepted_by, requested_at, accepted_at, rules_version,
        listing_snapshot, counter_listing_snapshot, party_a, party_b
      )
      SELECT a.id, b.id, e.id, c.id, l.id, counter.id, m.id,
        CASE WHEN EXISTS (SELECT 1 FROM disclosures d WHERE d.user_a_id = a.id AND d.user_b_id = b.id)
          THEN 'REPEAT' ELSE 'FIRST' END,
        e.requested_by, e.accepted_by, p.requested_at, e.accepted_at, $2,
        disclosure_listing_snapshot(l), CASE WHEN counter.id IS NOT NULL THEN disclosure_listing_snapshot(counter) END,
        disclosure_party_snapshot(a, e.a_version), disclosure_party_snapshot(b, e.b_version)
      FROM chat_contact_exchanges e JOIN chats c ON c.id = e.chat_id JOIN listings l ON l.id = c.listing_id
      JOIN users a ON a.id = least(e.requested_by, e.accepted_by)
      JOIN users b ON b.id = greatest(e.requested_by, e.accepted_by)
      JOIN telegram_consents p ON p.user_a_id = a.id AND p.user_b_id = b.id
      LEFT JOIN listing_matches m ON m.id = c.match_id
      LEFT JOIN listings counter ON counter.id = CASE WHEN m.sell_listing_id = l.id THEN m.buy_listing_id ELSE m.sell_listing_id END
      WHERE e.id = $1 RETURNING *
    `, [exchangeId, rulesVersion])
    if (!row) throw new ConflictException('Не удалось зафиксировать раскрытие')
    const number = disclosureNumber(row.number)
    const first = row.kind === 'FIRST'
    for (const [id, partner] of [[row.user_a_id, row.party_b], [row.user_b_id, row.party_a]] as const) {
      // The record and the chat are authorization-checked. Email is only an alert.
      const token = first ? await this.actions.issue(db, { purpose: 'disclosure.already_known', subjectId: row.id, userId: id,
        expiresAt: new Date(row.accepted_at.getTime() + 24 * 60 * 60 * 1000) }) : undefined
      await this.notifications.notify(db, id, {
        kind: first ? 'disclosure.first' : 'disclosure.repeat',
        title: first ? `Раскрытие ${number} зафиксировано` : 'Обмен Telegram обновлён после смены ника',
        body: first
          ? `Компания собеседника: ${this.company(partner) ?? 'Не указана'}. Если вы были знакомы раньше, отметьте это в течение 24 часов.`
          : 'Актуальные контакты доступны в чате.',
        payload: { disclosureId: row.id, chatId: row.chat_id, number },
        actions: [
          { label: 'Открыть чат', href: '/chats/' + row.chat_id, action: 'open' },
          ...(token ? [{ label: 'Уже знакомы', token, action: 'disclosure.already_known' }] : []),
        ],
        dedupeKey: 'disclosure.accept:' + row.id,
        channels: first ? ['EMAIL'] : [],
      })
    }
    return { id: row.id, number, kind: row.kind }
  }

  async list(user: SessionUser, query: Record<string, unknown>, staff = false) {
    const paging = pageParams(query)
    const params = new Parameters()
    const filters: string[] = []
    if (staff) {
      if (query.userId) {
        const owner = params.add(uuid(query.userId, 'Участник'))
        filters.push(`(user_a_id = ${owner} OR user_b_id = ${owner})`)
      }
      if (query.q) {
        const phrase = str(query.q, 'Поиск', 0, 200)
        const term = params.add('%' + phrase.replace(/[\\%_]/g, '\\$&') + '%')
        filters.push(`concat_ws(' ', party_a->>'nickname', party_a->>'companyName', party_b->>'nickname',
          party_b->>'companyName', listing_snapshot->>'title', 'R-' || lpad(number::text, greatest(6, length(number::text)), '0')) ILIKE ${term}`)
      }
      if (query.from || query.to) {
        const timezone = params.add(await this.settings.get<string>('timezone'))
        if (query.from) filters.push(`(accepted_at AT TIME ZONE ${timezone})::date >= ${params.add(calendarDate(query.from, 'Дата от'))}::date`)
        if (query.to) filters.push(`(accepted_at AT TIME ZONE ${timezone})::date <= ${params.add(calendarDate(query.to, 'Дата до'))}::date`)
      }
    } else {
      const id = params.add(user.id)
      filters.push(`(user_a_id = ${id} OR user_b_id = ${id})`)
    }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : ''
    const countValues = [...params.values]
    const limit = params.add(paging.limit)
    const offset = params.add(paging.offset)
    const [result, count, timezone] = await Promise.all([
      this.db.query<DisclosureRow & { known: string[] }>(`
        SELECT d.*, ARRAY(SELECT actor_user_id::text FROM disclosure_events e
          WHERE e.disclosure_id = d.id AND e.type = 'ALREADY_KNOWN') AS known
        FROM disclosures d ${where} ORDER BY accepted_at DESC, number DESC LIMIT ${limit} OFFSET ${offset}
      `, params.values),
      this.db.query<{ total: number }>('SELECT count(*)::int AS total FROM disclosures ' + where, countValues),
      this.settings.get<string>('timezone'),
    ])
    return {
      items: result.rows.map(row => staff ? this.staffSummary(row) : this.participantSummary(row, user.id, row.known)),
      total: count.rows[0].total, page: paging.page, limit: paging.limit, timezone,
    }
  }

  async detail(user: SessionUser, idInput: string, staff = false) {
    const row = await this.get(this.db, idInput, staff ? undefined : user.id)
    const { rows: events } = await this.db.query<DisclosureEvent>(`
      SELECT type, actor_user_id, data, created_at FROM disclosure_events
      WHERE disclosure_id = $1 ${staff ? '' : "AND type <> 'ADMIN_NOTE'"} ORDER BY id
    `, [row.id])
    const known = events.filter(event => event.type === 'ALREADY_KNOWN').map(event => event.actor_user_id ?? '')
    const timezone = await this.settings.get<string>('timezone')
    return {
      ...(staff ? this.staffSummary(row) : this.participantSummary(row, user.id, known)),
      partner: staff ? undefined : this.partner(row, user.id, true),
      listing: row.listing_snapshot, counterListing: row.counter_listing_snapshot,
      matchId: row.match_id, requestedAt: row.requested_at, rulesVersion: row.rules_version, timezone,
      events: events.map(event => staff
        ? { type: event.type, actorUserId: event.actor_user_id, data: event.data, at: event.created_at }
        : { type: event.type, by: event.actor_user_id === user.id ? 'mine' : event.actor_user_id ? 'partner' : 'system', at: event.created_at }),
    }
  }

  async participantExport(client: Queryable, userId: string) {
    const { rows } = await client.query<DisclosureRow & { known: string[]; events: {
      type: string; by: 'mine' | 'partner' | 'system'; at: Date;
    }[] }>(`
      SELECT d.*,
        ARRAY(SELECT actor_user_id::text FROM disclosure_events e
          WHERE e.disclosure_id=d.id AND e.type='ALREADY_KNOWN') AS known,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('type',e.type,'at',e.created_at,'by',
          CASE WHEN e.actor_user_id=$1 THEN 'mine' WHEN e.actor_user_id IS NOT NULL THEN 'partner' ELSE 'system' END)
          ORDER BY e.id) FROM disclosure_events e WHERE e.disclosure_id=d.id AND e.type<>'ADMIN_NOTE'),'[]') AS events
      FROM disclosures d WHERE d.user_a_id=$1 OR d.user_b_id=$1 ORDER BY number
    `, [userId])
    return rows.map(row => ({
      ...this.participantSummary(row, userId, row.known),
      partner: this.partner(row, userId, true), listing: row.listing_snapshot, counterListing: row.counter_listing_snapshot,
      matchId: row.match_id, requestedAt: row.requested_at, rulesVersion: row.rules_version, events: row.events,
    }))
  }

  async alreadyKnown(user: SessionUser, idInput: string) {
    return this.db.transaction(client => this.markAlreadyKnown(client, user.id, idInput))
  }

  private async markAlreadyKnown(client: Queryable, userId: string, idInput: string) {
      const row = await this.get(client, idInput, userId)
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[row.user_a_id, row.user_b_id]])
      const { rows: [event] } = await client.query<{ at: Date }>(`
        INSERT INTO disclosure_events (disclosure_id, actor_user_id, type)
        SELECT id, $2, 'ALREADY_KNOWN' FROM disclosures
        WHERE id = $1 AND kind = 'FIRST' AND accepted_at >= now() - interval '24 hours'
        ON CONFLICT DO NOTHING RETURNING created_at AS at
      `, [row.id, userId])
      if (!event) {
        const known = await client.query(`
          SELECT 1 FROM disclosure_events WHERE disclosure_id = $1 AND actor_user_id = $2 AND type = 'ALREADY_KNOWN'
        `, [row.id, userId])
        if (known.rowCount) throw new ConflictException('Уже отмечено')
        throw new ConflictException('Отметить «Уже знакомы» можно в течение 24 часов после первого раскрытия')
      }
      const partner = row.user_a_id === userId ? row.user_b_id : row.user_a_id
      const number = disclosureNumber(row.number)
      await this.notifications.notify(client, partner, {
        kind: 'disclosure.already_known', title: 'Отметка о знакомстве',
        body: `Собеседник отметил, что вы знакомы до площадки (запись ${number}).`,
        actions: [{ label: 'Открыть запись', href: '/disclosures/' + row.id, action: 'open' }],
        dedupeKey: 'disclosure.already-known:' + row.id + ':' + userId, channels: [],
      })
      return { type: 'ALREADY_KNOWN', by: 'mine', at: event.at }
  }

  async note(user: SessionUser, idInput: string, raw: unknown) {
    const note = str(object(raw).text, 'Заметка', 10, 2000)
    return this.db.transaction(async client => {
      const row = await this.get(client, idInput)
      const { rows: [event] } = await client.query(`
        INSERT INTO disclosure_events (disclosure_id, actor_user_id, type, data)
        VALUES ($1,$2,'ADMIN_NOTE',jsonb_build_object('text', $3::text))
        RETURNING type, created_at AS at, data
      `, [row.id, user.id, note])
      await auditExchange(client, user, 'disclosures', row.id, 'note-added', undefined, { text: note })
      return event
    })
  }

  private async get(db: Queryable, idInput: string, participantId?: string) {
    const { rows: [row] } = await db.query<DisclosureRow>(`
      SELECT * FROM disclosures WHERE id = $1 AND ($2::uuid IS NULL OR $2 IN (user_a_id, user_b_id))
    `, [uuid(idInput), participantId ?? null])
    if (!row) throw new NotFoundException('Запись раскрытия не найдена')
    return row
  }

  private company(party: Party) {
    return party.participantType === 'INDIVIDUAL' ? 'Частное лицо' : party.companyName
  }

  private partner(row: DisclosureRow, userId: string, withTelegram = false) {
    const party = row.user_a_id === userId ? row.party_b : row.party_a
    return {
      nickname: party.nickname, companyName: this.company(party), participantType: party.participantType,
      country: party.country, ...(withTelegram && { telegram: party.telegram }),
    }
  }

  private participantSummary(row: DisclosureRow, userId: string, known: string[]) {
    const partnerId = row.user_a_id === userId ? row.user_b_id : row.user_a_id
    return {
      id: row.id, number: disclosureNumber(row.number), kind: row.kind, acceptedAt: row.accepted_at,
      partner: this.partner(row, userId), chatId: row.chat_id, migrated: row.migrated,
      listing: { id: row.listing_snapshot.id, title: row.listing_snapshot.title, kind: row.listing_snapshot.kind },
      alreadyKnown: { mine: known.includes(userId), partner: known.includes(partnerId) },
      canMarkKnown: row.kind === 'FIRST' && !known.includes(userId) && Date.now() - row.accepted_at.getTime() <= 86400000,
    }
  }

  private staffSummary(row: DisclosureRow) {
    return {
      id: row.id, number: disclosureNumber(row.number), kind: row.kind, acceptedAt: row.accepted_at,
      partyA: row.party_a, partyB: row.party_b, listing: row.listing_snapshot, chatId: row.chat_id,
      requestedBy: row.requested_by, acceptedBy: row.accepted_by, migrated: row.migrated,
    }
  }
}
