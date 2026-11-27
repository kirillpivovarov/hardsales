import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common'
import type { PoolClient } from 'pg'
import type { ParticipantRole, SessionUser } from '../auth/auth.types'
import { outsideContact, withContact } from '../contact'
import { chatBlockedMessage, ContactGuardService, hiddenContactMessage } from '../contact-guard/contact-guard.service'
import { detectContacts, detectSplitContact, requestsOutsideChat } from '../contact-guard/detect'
import { publicListingTitle, withoutLegacyProfileContacts } from '../contact-guard/public-text'
import { DatabaseService, type Queryable } from '../database/database.service'
import { ExchangeActions } from '../exchange/actions'
import { DealsService } from '../exchange/deals.service'
import { disclosureTerms, DisclosuresService } from '../exchange/disclosures.service'
import { chatUnread } from '../exchange/notification-queues'
import { ExchangeNotifications } from '../exchange/notifications'
import { OnboardingService } from '../exchange/onboarding.service'
import { PlatformSettings } from '../exchange/platform-settings'
import { integer, object, oneOf, pageParams, str, uuid } from './market.inputs'
import { listingPublicWhere, publicProfile, visibleCategories } from './market.queries'

type ChatContext = {
  owner_id: string
  visitor_id: string
  user_a_id: string
  user_b_id: string
  current_a_version: string
  current_b_version: string
  a_handle: string | null
  b_handle: string | null
  a_telegram_verified: boolean
  b_telegram_verified: boolean
  active: boolean
}

type PairConsent = {
  state: 'NONE' | 'REQUESTED' | 'ACCEPTED' | 'DECLINED'
  requested_by: string | null
  request_id: string | null
  a_version: string | null
  b_version: string | null
  last_accepted_at: Date | null
  requested_rules_version: string | null
}

type ChatRow = {
  id: string
  listing: { title: string }
  partner: { nickname: string; city: string | null }
  disclosureRulesRequired: boolean
  ownListing: boolean
} & Record<string, unknown>

function participantChat({ ownListing, ...chat }: ChatRow) {
  if (!chat.disclosureRulesRequired) return chat
  return {
    ...chat,
    listing: ownListing ? chat.listing : { ...chat.listing, title: publicListingTitle(chat.listing.title) },
    partner: withoutLegacyProfileContacts(chat.partner),
  }
}

const messages = (body = 'm.body') => `m.id::float8 AS id, m.sender_id AS "senderId", ${body} AS body,
  m.contact_warning AS "contactWarning", m.created_at AS "createdAt"`
const peerBody = (viewer: string, enabled: string) => `CASE WHEN m.sender_id <> ${viewer} AND m.hidden_for_peer AND (${enabled})
  THEN '${hiddenContactMessage}' ELSE m.body END`
const chatJoins = `FROM chats c
  JOIN listings l ON l.id = c.listing_id
  JOIN users owner ON c.owner_id = owner.id
  JOIN users visitor ON c.visitor_id = visitor.id
  JOIN users partner ON partner.id = CASE WHEN c.owner_id = $1 THEN c.visitor_id ELSE c.owner_id END
`
const memberWhere = '(c.owner_id = $1 OR c.visitor_id = $1)'
const chatActive = `owner.status = 'ACTIVE' AND visitor.status = 'ACTIVE' AND
  owner.email_verified_at IS NOT NULL AND visitor.email_verified_at IS NOT NULL AND
  l.status NOT IN ('FROZEN', 'BANNED')`
const userA = 'least(c.owner_id, c.visitor_id)'
const userB = 'greatest(c.owner_id, c.visitor_id)'
const versionA = 'CASE WHEN c.owner_id < c.visitor_id THEN owner.telegram_version ELSE visitor.telegram_version END'
const versionB = 'CASE WHEN c.owner_id < c.visitor_id THEN visitor.telegram_version ELSE owner.telegram_version END'
const managesDisclosures = "coalesce(disclosure_setting.value = 'true'::jsonb, false)"
const contactPolicyEnabled = `EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_disclosure_journal' AND value = 'true'::jsonb)`
const pairJoin = `LEFT JOIN telegram_consents p ON p.user_a_id = ${userA} AND p.user_b_id = ${userB}
  LEFT JOIN platform_settings disclosure_setting ON disclosure_setting.key = 'feature_disclosure_journal'
  LEFT JOIN platform_settings current_rules ON current_rules.key = 'rules_version'
  LEFT JOIN LATERAL (
    SELECT id, number, kind, accepted_at FROM disclosures d
    WHERE d.user_a_id = ${userA} AND d.user_b_id = ${userB}
      AND p.last_accepted_at IS NOT NULL AND ${managesDisclosures}
    ORDER BY accepted_at DESC, number DESC LIMIT 1
  ) disclosed ON true`
const consentCurrent = `p.a_version = (${versionA}) AND p.b_version = (${versionB})`
const pendingRulesCurrent = `(p.state <> 'REQUESTED' OR NOT (${managesDisclosures}) OR
  p.requested_rules_version IS NOT DISTINCT FROM (current_rules.value #>> '{}'))`
const requiresDisclosureUpgrade = `(${managesDisclosures} AND p.state = 'ACCEPTED' AND disclosed.id IS NULL)`
const sharedTelegram = `${chatActive} AND p.state = 'ACCEPTED' AND ${consentCurrent} AND NOT ${requiresDisclosureUpgrade}`
const telegramBotEnabled = `EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_telegram' AND value = 'true'::jsonb)`
const changedA = `coalesce(p.last_accepted_a_version <> (${versionA}), false)`
const changedB = `coalesce(p.last_accepted_b_version <> (${versionB}), false)`
const reviewCheck = `EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id = $1)
  AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id = partner.id)`
const chatColumns = `
  c.id, c.created_at AS "createdAt",
  c.owner_id = $1 AS "ownListing",
  jsonb_build_object('id', l.id, 'title', l.title, 'status', l.status, 'kind', l.kind) AS listing,
  ${publicProfile('partner')} || jsonb_build_object(
    'companyName', CASE WHEN disclosed.id IS NOT NULL THEN
      CASE WHEN partner.participant_type = 'INDIVIDUAL' THEN 'Частное лицо' ELSE partner.company_name END END,
    'disclosedAt', disclosed.accepted_at
  ) AS partner,
  ${managesDisclosures} AS "disclosureRulesRequired",
  CASE WHEN ${managesDisclosures} THEN jsonb_build_object(
    'minimum', (SELECT value FROM platform_settings WHERE key='disclosure_min_level'),
    'mine', CASE WHEN c.owner_id=$1 THEN owner.verification_level ELSE visitor.verification_level END,
    'partner', partner.verification_level
  ) END AS "verification",
  (NOT ${managesDisclosures} OR disclosed.id IS NOT NULL) AS "contactsAllowed",
  CASE WHEN ${managesDisclosures} THEN current_rules.value #>> '{}' END AS "disclosureRulesVersion",
  CASE WHEN disclosed.id IS NOT NULL THEN jsonb_build_object('id', disclosed.id,
    'number', 'R-' || lpad(disclosed.number::text, greatest(6, length(disclosed.number::text)), '0'),
    'kind', disclosed.kind) END AS disclosure,
  (SELECT jsonb_build_object('id', m.id, 'body', ${peerBody('$1', managesDisclosures)}, 'senderId', m.sender_id, 'createdAt', m.created_at)
    FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessage",
  (SELECT count(*)::int FROM chat_messages m WHERE m.chat_id = c.id AND m.sender_id != $1 AND
    m.id > CASE WHEN c.owner_id = $1 THEN c.owner_read_id ELSE c.visitor_read_id END) AS "unreadCount",
  CASE WHEN ${consentCurrent} AND ${pendingRulesCurrent} AND NOT ${requiresDisclosureUpgrade} THEN p.state ELSE 'NONE' END AS "revealState",
  CASE WHEN ${consentCurrent} AND ${pendingRulesCurrent} AND NOT ${requiresDisclosureUpgrade} THEN p.requested_by END AS "revealRequestedBy",
  CASE WHEN p.state = 'REQUESTED' AND ${consentCurrent} AND ${pendingRulesCurrent} THEN p.request_id END AS "revealRequestId",
  CASE WHEN ${sharedTelegram} THEN jsonb_build_object(
    'mine', CASE WHEN c.owner_id = $1 THEN owner.telegram ELSE visitor.telegram END,
    'partner', CASE WHEN c.owner_id = $1 THEN visitor.telegram ELSE owner.telegram END
  ) END AS telegram,
  CASE WHEN ${sharedTelegram} THEN jsonb_build_object(
    'mine', ${telegramBotEnabled} AND CASE WHEN c.owner_id = $1 THEN telegram_handle_verified(owner) ELSE telegram_handle_verified(visitor) END,
    'partner', ${telegramBotEnabled} AND telegram_handle_verified(partner)
  ) END AS "telegramVerification",
  CASE WHEN p.last_accepted_at IS NOT NULL AND
    (p.last_accepted_a_version IS NULL OR ${changedA} OR ${changedB}) THEN jsonb_build_object(
      'mine', CASE WHEN p.user_a_id = $1 THEN ${changedA} ELSE ${changedB} END,
      'partner', CASE WHEN p.user_a_id = $1 THEN ${changedB} ELSE ${changedA} END
  ) END AS "telegramChanged",
  CASE WHEN ${chatActive} THEN 'ACTIVE' ELSE 'RESTRICTED' END AS status,
  EXISTS (SELECT 1 FROM reviews r WHERE r.chat_id = c.id AND r.author_id = $1) AS "hasReview",
  EXISTS (SELECT 1 FROM reports r WHERE r.chat_id = c.id AND r.reporter_id = $1) AS "hasReport",
  (p.last_accepted_at IS NOT NULL) AS "canReportTelegram",
  (${chatActive} AND ${reviewCheck}
    AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.chat_id = c.id AND r.author_id = $1)) AS "canReview"
`

@Injectable()
export class ChatsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly disclosures: DisclosuresService,
    private readonly onboarding: OnboardingService,
    private readonly contactGuard: ContactGuardService,
    private readonly actions: ExchangeActions,
    private readonly deals: DealsService,
    private readonly notifications: ExchangeNotifications,
  ) {}

  onModuleInit() {
    this.actions.register('chat.reveal', {
      describe: async () => ({ title: 'Запрос обмена контактами', fields: { rules: disclosureTerms } }),
      lockSubjects: async (client, token) => {
        await client.query(`SELECT u.id FROM users u JOIN chats c ON u.id IN (c.owner_id,c.visitor_id)
          WHERE c.id=$1 AND $2 IN (c.owner_id,c.visitor_id) ORDER BY u.id FOR UPDATE OF u`, [token.subjectId, token.userId])
      },
      execute: async (client, token, raw) => {
        const input = object(raw)
        const action = oneOf(input.action, ['ACCEPT', 'DECLINE'], 'Действие')
        await this.revealInTransaction(client, token.userId!, token.subjectId, {
          action, requestId: token.payload.requestId, rulesAccepted: input.rulesAccepted,
        })
        return { message: action === 'ACCEPT' ? 'Обмен принят' : 'Обмен отклонён' }
      },
    })
  }

  async list(user: SessionUser<ParticipantRole>, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query, 30)
    const [rows, count] = await Promise.all([
      this.db.query<ChatRow>(`
        SELECT ${chatColumns} ${chatJoins} ${pairJoin} WHERE ${memberWhere}
        ORDER BY coalesce((SELECT max(m.created_at) FROM chat_messages m WHERE m.chat_id = c.id),
          c.created_at) DESC, c.id LIMIT $2 OFFSET $3
      `, [user.id, limit, offset]),
      this.db.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM chats c WHERE ${memberWhere}
      `, [user.id]),
    ])
    return { items: rows.rows.map(participantChat), total: count.rows[0].total, page, limit }
  }

  async detail(user: SessionUser<ParticipantRole>, idInput: string) {
    return this.show(this.db, user.id, uuid(idInput))
  }

  async startDeal(user: SessionUser<ParticipantRole>, idInput: string) {
    const id = uuid(idInput)
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      return this.deals.startFromChat(client, id, user.id, 'MANUAL')
    })
  }

  async unreadCount(user: SessionUser<ParticipantRole>) {
    const { rows: [result] } = await this.db.query<{ unread: number }>(`SELECT (${chatUnread}) AS unread`, [user.id])
    return result
  }

  async create(user: SessionUser<ParticipantRole>, raw: unknown) {
    const listingId = uuid(object(raw).listingId, 'Объявление')
    return this.db.transaction(async client => {
      await this.onboarding.assertOnboardingComplete(user.id, client)
      await client.query(`SELECT id FROM users WHERE id = $2 OR id = (SELECT owner_id FROM listings WHERE id = $1)
        ORDER BY id FOR SHARE`, [listingId, user.id])
      const { rows } = await client.query<{ id: string; owner_id: string; counterparty: string; actor_type: string }>(`
        ${visibleCategories}
        SELECT l.id, l.owner_id, l.counterparty, actor.participant_type AS actor_type
        FROM listings l JOIN users u ON u.id = l.owner_id
        JOIN users actor ON actor.id = $2 AND actor.status = 'ACTIVE' AND actor.email_verified_at IS NOT NULL
        WHERE l.id = $1 AND l.owner_id != $2
          AND (CASE WHEN l.kind = 'SELL' THEN 'BUY' ELSE 'SELL' END) = ANY(actor.trade_sides)
          AND ${listingPublicWhere}
        FOR SHARE OF l
      `, [listingId, user.id])
      const listing = rows[0]
      if (!listing) throw new NotFoundException('Объявление недоступно')
      if (listing.counterparty === 'COMPANY' && listing.actor_type !== 'COMPANY') {
        throw new ForbiddenException('Автор объявления принимает предложения только от компаний')
      }
      await client.query(`
        INSERT INTO chats (listing_id, owner_id, visitor_id)
        VALUES ($1, $2, $3) ON CONFLICT (listing_id, visitor_id) DO NOTHING
      `, [listingId, listing.owner_id, user.id])
      const chat = await client.query<{ id: string }>(
        'SELECT id FROM chats WHERE listing_id = $1 AND visitor_id = $2', [listingId, user.id],
      )
      return this.show(client, user.id, chat.rows[0].id)
    })
  }

  async history(user: SessionUser<ParticipantRole>, idInput: string, query: Record<string, unknown>) {
    const id = uuid(idInput)
    await this.context(this.db, user.id, id)
    const limit = query.limit === undefined ? 100 : integer(query.limit, 'Размер истории', 1, 100)
    const before = query.before === undefined ? null : integer(query.before, 'Сообщение', 1, Number.MAX_SAFE_INTEGER)
    const after = query.after === undefined ? null : integer(query.after, 'Сообщение', 0, Number.MAX_SAFE_INTEGER)
    if (before !== null && after !== null) throw new BadRequestException('Укажите только одну границу истории')
    const { rows } = await this.db.query(`
      SELECT * FROM (
        SELECT ${messages(peerBody('$5', contactPolicyEnabled))} FROM chat_messages m
        WHERE m.chat_id = $1 AND ($2::bigint IS NULL OR m.id < $2) AND ($3::bigint IS NULL OR m.id > $3)
        ORDER BY m.id ${after === null ? 'DESC' : 'ASC'} LIMIT $4
      ) result ORDER BY id
    `, [id, before, after, limit, user.id])
    return rows
  }

  async send(user: SessionUser<ParticipantRole>, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const outcome = await this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      const body = str(object(raw).body, 'Сообщение', 1, 4000)
      await this.onboarding.assertOnboardingComplete(user.id, client)
      await client.query("SELECT key FROM platform_settings WHERE key = 'feature_disclosure_journal' FOR SHARE")
      const strict = await this.contactGuard.enabled(client)
      const { rows: [access] } = await client.query<{ disclosed: boolean }>(`
        SELECT EXISTS(SELECT 1 FROM disclosures WHERE user_a_id = $1 AND user_b_id = $2) AS disclosed
      `, [context.user_a_id, context.user_b_id])
      const consent = await this.pairConsent(client, context)
      const confirmed = consent?.state === 'ACCEPTED' && this.consentMatches(context, consent)
        ? [context.a_handle, context.b_handle] : []
      const { rows: recent } = await client.query<{ total: number }>(`
        SELECT (SELECT count(*) FROM chat_messages WHERE chat_id = $1 AND sender_id = $2
          AND created_at > now() - interval '1 minute')::int +
          (SELECT count(*) FROM contact_block_events WHERE chat_id = $1 AND user_id = $2 AND surface = 'CHAT'
          AND created_at > now() - interval '1 minute')::int AS total
      `, [id, user.id])
      if (recent[0].total >= 30) throw new HttpException('Слишком много сообщений. Попробуйте через минуту.', 429)
      let kinds = access.disclosed ? [] : detectContacts(body)
      if (!access.disclosed && !kinds.length) {
        const previous = await client.query<{ body: string }>(`
          SELECT body FROM chat_messages WHERE chat_id = $1 AND sender_id = $2
            AND created_at > now() - interval '10 minutes' ORDER BY id DESC LIMIT 5
        `, [id, user.id])
        kinds = detectSplitContact(previous.rows.reverse().map(row => row.body), body)
      }
      if (strict && kinds.length) {
        const warning = await this.contactGuard.block(client, {
          userId: user.id, peerId: this.partner(context, user.id), chatId: id, surface: 'CHAT', body, kinds,
        })
        return { blocked: { code: 'CONTACT_BLOCKED', message: chatBlockedMessage, kinds, warning } }
      }
      const { rows } = await client.query(`
        INSERT INTO chat_messages AS m (chat_id, sender_id, body, contact_warning, hidden_for_peer)
        VALUES ($1, $2, $3, $4, $5) RETURNING ${messages()}
      `, [id, user.id, body, strict ? !access.disclosed && requestsOutsideChat(body) : withContact(body, confirmed), Boolean(kinds.length)])
      await this.notifications.chatMessage(client, id, this.partner(context, user.id), user.id, rows[0].id)
      await client.query(`
        UPDATE listing_matches SET
          seller_first_action_at = CASE WHEN seller_id = $2 THEN coalesce(seller_first_action_at, now()) ELSE seller_first_action_at END,
          buyer_first_action_at = CASE WHEN buyer_id = $2 THEN coalesce(buyer_first_action_at, now()) ELSE buyer_first_action_at END
        WHERE chat_id = $1 AND status = 'CHAT' AND (
          (seller_id = $2 AND seller_first_action_at IS NULL) OR (buyer_id = $2 AND buyer_first_action_at IS NULL)
        )
      `, [id, user.id])
      await this.deals.startFromChat(client, id, user.id, 'PAIR_CHAT')
      return { message: rows[0] }
    })
    if (outcome.blocked) throw new HttpException(outcome.blocked, 422)
    return outcome.message
  }

  async read(user: SessionUser<ParticipantRole>, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = raw === undefined ? {} : object(raw)
    const messageId = body.messageId === undefined ? null : integer(body.messageId, 'Сообщение', 1, Number.MAX_SAFE_INTEGER)
    await this.db.transaction(async client => {
      const { rows: [marker] } = await client.query<{ through: string }>(`
        UPDATE chats c SET
          owner_read_id = CASE WHEN c.owner_id = $1 THEN greatest(c.owner_read_id, position.id) ELSE c.owner_read_id END,
          visitor_read_id = CASE WHEN c.visitor_id = $1 THEN greatest(c.visitor_read_id, position.id) ELSE c.visitor_read_id END
        FROM (SELECT coalesce(max(m.id), 0) AS id FROM chat_messages m
          WHERE m.chat_id = $2 AND m.sender_id != $1 AND ($3::bigint IS NULL OR m.id <= $3)) position
        WHERE c.id = $2 AND ${memberWhere}
        RETURNING (CASE WHEN c.owner_id=$1 THEN c.owner_read_id ELSE c.visitor_read_id END)::text AS through
      `, [user.id, id, messageId])
      if (!marker) throw new NotFoundException('Чат не найден')
      await this.notifications.chatRead(client, id, user.id, marker.through)
    })
  }

  async reveal(user: SessionUser<ParticipantRole>, idInput: string, raw: unknown) {
    return this.db.transaction(client => this.revealInTransaction(client, user.id, idInput, raw))
  }

  private async revealInTransaction(client: PoolClient, userId: string, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    const action = oneOf(body.action, ['REQUEST', 'ACCEPT', 'DECLINE'], 'Действие')
    const requestId = action === 'REQUEST' ? null : uuid(body.requestId, 'Запрос')
    const context = await this.context(client, userId, id, true)
    this.assertActive(context)
    await client.query(`SELECT key FROM platform_settings
      WHERE key IN ('feature_disclosure_journal', 'rules_version', 'disclosure_min_level',
        'feature_telegram', 'disclosure_requires_verified_telegram') ORDER BY key FOR SHARE`)
    const journalling = await this.settings.enabled('feature_disclosure_journal', client)
    const pair = [context.user_a_id, context.user_b_id]
    await client.query(`
      INSERT INTO telegram_consents (user_a_id, user_b_id) VALUES ($1, $2)
      ON CONFLICT (user_a_id, user_b_id) DO NOTHING
    `, pair)
    // Both participant rows stay locked until the pair transition commits.
    const consent = (await this.pairConsent(client, context, true))!
    const current = this.consentMatches(context, consent)
    if (action === 'REQUEST') {
      const rulesVersion = journalling
        ? await this.disclosures.assertRules(client, userId, this.partner(context, userId), body.rulesAccepted, undefined, true)
        : null
      if (journalling && body.rulesVersion !== undefined && body.rulesVersion !== rulesVersion) {
        throw new ConflictException('Правила раскрытия обновились. Ознакомьтесь с новой версией.')
      }
      const needsUpgrade = journalling && consent.state === 'ACCEPTED' && !(await client.query(`
        SELECT 1 FROM disclosures WHERE user_a_id = $1 AND user_b_id = $2 LIMIT 1
      `, pair)).rowCount
      if (current && ((consent.state === 'ACCEPTED' && !needsUpgrade) ||
        (consent.state === 'REQUESTED' && (!journalling || consent.requested_rules_version === rulesVersion)))) {
        throw new ConflictException('Запрос уже сделан')
      }
      await this.assertTelegramVerification(client, context, userId)
      if (!context.a_handle || !context.b_handle) throw new ConflictException('Обоим участникам нужен привязанный Telegram')
      const { rows: [updated] } = await client.query<{ request_id: string }>(`
        UPDATE telegram_consents SET state = 'REQUESTED', requested_by = $3, request_id = gen_random_uuid(),
          a_version = $4, b_version = $5, requested_at = now(), requested_rules_version = $6
        WHERE user_a_id = $1 AND user_b_id = $2 RETURNING request_id
      `, [...pair, userId, context.current_a_version, context.current_b_version, rulesVersion])
      if (journalling) await this.disclosures.requestNotice(client, userId, this.partner(context, userId), id, updated.request_id)
    } else {
      if (!current || consent.state !== 'REQUESTED' || consent.request_id !== requestId ||
        !consent.requested_by || consent.requested_by === userId) {
        throw new ConflictException('Ответить может получатель активного запроса')
      }
      if (action === 'ACCEPT') {
        const rulesVersion = journalling ? await this.disclosures.assertRules(
          client, userId, this.partner(context, userId), body.rulesAccepted, consent.requested_rules_version,
        ) : null
        if (journalling && body.rulesVersion !== undefined && body.rulesVersion !== rulesVersion) {
          throw new ConflictException('Правила раскрытия обновились. Запросите обмен заново.')
        }
        await this.assertTelegramVerification(client, context, userId)
        if (!context.a_handle || !context.b_handle) throw new ConflictException('Обоим участникам нужен привязанный Telegram')
        const { rows: [exchange] } = await client.query<{ id: string }>(`
          WITH accepted AS (
            INSERT INTO chat_contact_exchanges (chat_id, requested_by, accepted_by, a_version, b_version)
            VALUES ($3, $4, $5, $6, $7) RETURNING id, accepted_at, a_version, b_version
          )
          UPDATE telegram_consents p SET state = 'ACCEPTED', last_accepted_at = accepted.accepted_at,
            last_accepted_a_version = accepted.a_version, last_accepted_b_version = accepted.b_version
          FROM accepted WHERE p.user_a_id = $1 AND p.user_b_id = $2 RETURNING accepted.id
        `, [...pair, id, consent.requested_by, userId, consent.a_version, consent.b_version])
        if (rulesVersion !== null) await this.disclosures.create(client, exchange.id, rulesVersion)
      } else {
        await client.query(`
          UPDATE telegram_consents SET state = 'DECLINED' WHERE user_a_id = $1 AND user_b_id = $2
        `, pair)
        const { rows: [listing] } = await client.query<{ title: string }>(
          'SELECT l.title FROM chats c JOIN listings l ON l.id=c.listing_id WHERE c.id=$1', [id],
        )
        await this.notifications.notify(client, consent.requested_by, {
          kind: 'disclosure.declined', title: 'Обмен контактами отклонён',
          body: `Собеседник пока не готов обменяться контактами по объявлению «${publicListingTitle(listing.title)}». Продолжайте переписку в чате.`,
          actions: [{ label: 'Открыть чат', href: '/chats/' + id }], channels: ['EMAIL'],
          dedupeKey: 'disclosure.declined:' + requestId,
        })
      }
    }
    return this.show(client, userId, id)
  }

  async review(user: SessionUser<ParticipantRole>, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    const rating = integer(body.rating, 'Оценка', 1, 5)
    const comment = str(body.comment ?? '', 'Отзыв', 0, 1000)
    const context = await this.context(this.db, user.id, id)
    await this.contactGuard.assertFields(user.id, 'REVIEW', { comment }, { chatId: id, peerId: this.partner(context, user.id) })
    if (outsideContact(comment)) throw new BadRequestException('Уберите контакты из отзыва')
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      this.assertActive(context)
      const subject = this.partner(context, user.id)
      const { rows: participants } = await client.query<{ total: number }>(`
        SELECT count(DISTINCT sender_id)::int AS total FROM chat_messages WHERE chat_id = $1 AND sender_id IN ($2, $3)
      `, [id, user.id, subject])
      if (participants[0].total < 2) throw new ConflictException('Отзыв доступен после обмена сообщениями')
      const { rows } = await client.query(`
        INSERT INTO reviews (chat_id, author_id, subject_id, rating, comment)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chat_id, author_id) DO NOTHING
        RETURNING id, rating, comment, status, created_at AS "createdAt"
      `, [id, user.id, subject, rating, comment])
      if (!rows[0]) throw new ConflictException('Вы уже оставили отзыв в этом чате')
      return rows[0]
    })
  }

  async report(user: SessionUser<ParticipantRole>, idInput: string, raw: unknown) {
    const id = uuid(idInput)
    const body = object(raw)
    const reason = oneOf(body.reason, ['FRAUD', 'ABUSE', 'OTHER'], 'Причина')
    const scope = oneOf(body.scope ?? 'ON_PLATFORM', ['ON_PLATFORM', 'VERIFIED_TELEGRAM'], 'Источник')
    const details = str(body.details, 'Опишите проблему', 10, 4000)
    const context = await this.context(this.db, user.id, id)
    await this.contactGuard.assertFields(user.id, 'REPORT', { details }, { chatId: id, peerId: this.partner(context, user.id) })
    return this.db.transaction(async client => {
      const context = await this.context(client, user.id, id, true)
      if (scope === 'VERIFIED_TELEGRAM') {
        const consent = await this.pairConsent(client, context)
        if (!consent?.last_accepted_at) throw new BadRequestException('Мы принимаем жалобы по Telegram, раскрытому при обмене с этим собеседником')
      }
      const { rows } = await client.query(`
        INSERT INTO reports (chat_id, reporter_id, subject_id, reason, scope, details)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chat_id, reporter_id) DO NOTHING
        RETURNING id, reason, scope, details, status, created_at AS "createdAt"
      `, [id, user.id, this.partner(context, user.id), reason, scope, details])
      if (!rows[0]) throw new ConflictException('В этом чате уже есть ваша жалоба')
      return rows[0]
    })
  }

  private async show(db: Queryable, userId: string, id: string) {
    const { rows } = await db.query<ChatRow>(`
      SELECT ${chatColumns} ${chatJoins} ${pairJoin} WHERE ${memberWhere} AND c.id = $2
    `, [userId, id])
    if (!rows[0]) throw new NotFoundException('Чат не найден')
    const deal = await this.deals.chatStatus(db, id)
    return { ...participantChat(rows[0]), ...(deal && { deal }) }
  }

  private async context(db: Queryable, userId: string, id: string, lock = false): Promise<ChatContext> {
    if (lock) await db.query(`
      SELECT u.id FROM users u JOIN chats c ON u.id IN (c.owner_id, c.visitor_id)
      WHERE ${memberWhere} AND c.id = $2 ORDER BY u.id FOR SHARE OF u
    `, [userId, id])
    const { rows } = await db.query<ChatContext>(`
      SELECT c.owner_id, c.visitor_id, ${userA} AS user_a_id, ${userB} AS user_b_id,
        ${versionA} AS current_a_version, ${versionB} AS current_b_version,
        CASE WHEN c.owner_id < c.visitor_id THEN owner.telegram ELSE visitor.telegram END AS a_handle,
        CASE WHEN c.owner_id < c.visitor_id THEN visitor.telegram ELSE owner.telegram END AS b_handle,
        CASE WHEN c.owner_id < c.visitor_id THEN telegram_handle_verified(owner) ELSE telegram_handle_verified(visitor) END AS a_telegram_verified,
        CASE WHEN c.owner_id < c.visitor_id THEN telegram_handle_verified(visitor) ELSE telegram_handle_verified(owner) END AS b_telegram_verified,
        (${chatActive}) AS active
      ${chatJoins} WHERE ${memberWhere} AND c.id = $2
      ${lock ? 'FOR UPDATE OF c FOR SHARE OF l' : ''}
    `, [userId, id])
    if (!rows[0]) throw new NotFoundException('Чат не найден')
    return rows[0]
  }

  private partner(chat: ChatContext, userId: string) {
    return chat.owner_id === userId ? chat.visitor_id : chat.owner_id
  }

  private async assertTelegramVerification(db: Queryable, chat: ChatContext, userId: string) {
    if (!await this.settings.enabled('disclosure_requires_verified_telegram', db)) return
    const available = await this.settings.enabled('feature_telegram', db)
    const actorIsA = chat.user_a_id === userId
    if (!available || !(actorIsA ? chat.a_telegram_verified : chat.b_telegram_verified)) {
      throw new ForbiddenException({ code: 'TELEGRAM_NOT_VERIFIED_SELF',
        message: available ? 'Подтвердите свой Telegram: откройте профиль и подключите бота' : 'Подтверждение Telegram временно недоступно' })
    }
    if (!(actorIsA ? chat.b_telegram_verified : chat.a_telegram_verified)) {
      throw new ForbiddenException({ code: 'TELEGRAM_NOT_VERIFIED_PARTNER', message: 'Собеседник ещё не подтвердил Telegram' })
    }
  }

  private async pairConsent(db: Queryable, chat: ChatContext, lock = false): Promise<PairConsent | undefined> {
    const { rows } = await db.query<PairConsent>(`
      SELECT state, requested_by, request_id, a_version, b_version, last_accepted_at, requested_rules_version
      FROM telegram_consents WHERE user_a_id = $1 AND user_b_id = $2
      ${lock ? 'FOR UPDATE' : ''}
    `, [chat.user_a_id, chat.user_b_id])
    return rows[0]
  }

  private consentMatches(chat: ChatContext, consent: PairConsent) {
    return consent.a_version === chat.current_a_version && consent.b_version === chat.current_b_version
  }

  private assertActive(chat: ChatContext) {
    if (!chat.active) throw new ForbiddenException('Чат доступен только для просмотра')
  }
}
