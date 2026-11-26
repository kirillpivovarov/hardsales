import {
  BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Injectable,
  NotFoundException, type OnModuleInit,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { hashToken } from '../auth/auth.crypto'
import type { SessionUser } from '../auth/auth.types'
import { appOrigin, port } from '../config'
import { isSingleLine, outsideContact } from '../contact'
import { DatabaseService, type Queryable } from '../database/database.service'
import { boolean, object, oneOf, pageParams, str, uuid } from '../market/market.inputs'
import { ExchangeActions, type ExchangeAction } from './actions'
import { auditExchange } from './audit'
import { emailDomainKind } from './email-domains'
import { ExchangeJobs } from './jobs'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'
import { agentFee, type AgentFee } from './representation.rules'
import { renderLetter, type ThirdPartyLetter } from '../privacy/policy'

type Principal = {
  id: string; user_id: string; name: string; company: string; number: number
  platform_user_id: string | null; confirmed_at: Date | null; confirmed_via: string | null
  removed_at: Date | null; platform_requested_at: Date | null; platform_fee_snapshot: AgentFee | null
}

type Profile = {
  id: string; email: string; display_name: string; company_name: string | null; representation_mode: string
  status: string; company_email: string | null; company_email_domain_kind: string | null; company_email_confirmed_at: Date | null
  agent_fee_disclosed: boolean | null; agent_fee_kind: AgentFee['kind']; agent_fee_value: number | null
  agent_fee_payer: AgentFee['payer']; agent_fee_confirmed_at: Date | null; agent_fee_principal_says: string | null
}

type Letter = {
  id: string; kind: 'PRINCIPAL' | 'OWN'; user_id: string; principal_id: string | null; to_email: string
  domain_kind: 'CORPORATE' | 'PUBLIC'; status: string; fee_snapshot: AgentFee | null; sent_at: Date
}

const agentModes = ['AGENT', 'BOTH']
const companyFields = 'company_email, company_email_domain_kind, company_email_confirmed_at'
const feeFields = 'agent_fee_disclosed, agent_fee_kind, agent_fee_value::float8, agent_fee_payer, agent_fee_confirmed_at, agent_fee_principal_says'
const letterDurationMs = 14 * 86400000

const principalDetails = `p.id, p.number, p.name, p.company, p.email,
  p.confirmed_at IS NOT NULL AS confirmed, p.confirmed_at AS "confirmedAt", p.confirmed_via AS "confirmedVia",
  p.confirmed_by AS "confirmedBy", p.email_ack AS "emailAck", p.denied_at AS "deniedAt",
  p.requested_at AS "requestedAt",
  (SELECT jsonb_build_object('nickname', u.display_name) FROM users u WHERE u.id = p.platform_user_id) AS "platformUser",
  (SELECT count(*)::int FROM listings l WHERE l.principal_id = p.id AND l.status IN ('ACTIVE','HIDDEN','FROZEN')) AS "liveListings",
  (SELECT count(*)::int FROM listings l WHERE l.principal_id = p.id AND l.status = 'ARCHIVED') AS "archivedListings",
  (SELECT jsonb_build_object('id', j.id, 'toEmail', j.to_email, 'sentAt', j.sent_at,
    'status', j.status, 'deliveryStatus', j.delivery_status)
    FROM company_email_letters j
    WHERE j.principal_id = p.id ORDER BY j.sent_at DESC, j.id DESC LIMIT 1) AS "lastLetter"`

function displayText(value: unknown, label: string, minimum: number, maximum: number) {
  const clean = str(value, label, minimum, maximum)
  if (clean && (!isSingleLine(clean) || outsideContact(clean))) throw new BadRequestException(label + ': уберите контакты и переносы строк')
  return clean
}

function emailAddress(raw: unknown) {
  const email = str(raw, 'Рабочая почта', 3, 254).toLowerCase()
  return { email, domainKind: emailDomainKind(email) }
}

function feeFrom(profile: Profile): AgentFee {
  return {
    disclosed: Boolean(profile.agent_fee_disclosed), kind: profile.agent_fee_kind,
    value: profile.agent_fee_value, payer: profile.agent_fee_payer,
  }
}

function sameFee(a: AgentFee | null, b: AgentFee) {
  return a?.disclosed === b.disclosed && a.kind === b.kind && a.value === b.value && a.payer === b.payer
}

function feeText(fee: AgentFee | null) {
  if (!fee?.disclosed) return ''
  const who = fee.payer === 'SELLER' ? 'продавец' : fee.payer === 'BUYER' ? 'покупатель' : 'обе стороны'
  return `Вознаграждение агента: ${fee.value}${fee.kind === 'PERCENT' ? ' % от суммы' : ' за единицу'}, платит ${who}.`
}

@Injectable()
export class RepresentationService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly actions: ExchangeActions,
    private readonly notifications: ExchangeNotifications,
    private readonly jobs: ExchangeJobs,
  ) {}

  onModuleInit() {
    this.actions.register('principal.answer', {
      describe: async (client, token) => ({ title: 'Подтверждение представительства', fields: {
        hasFee: (await this.principal(client, String(token.payload.agentId), token.subjectId)).platform_fee_snapshot?.disclosed === true,
      } }),
      lockSubjects: async (client, token) => {
        await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[token.userId, token.payload.agentId]])
      },
      execute: (client, token, raw) => this.answerPlatformInTransaction(client, token.userId!, {
        ...object(raw), agentId: token.payload.agentId, principalId: token.subjectId,
      }, token.payload.requestedAt),
    })
    this.actions.register('email.optout', {
      describe: async () => ({ title: 'Отказ от писем площадки', fields: [] }),
      execute: (client, token) => this.optOut(client, token.subjectId),
    })
    for (const purpose of ['principal.confirm', 'company_email.confirm']) {
      this.actions.register(purpose, {
        describe: (client, token) => this.describeLetter(client, token),
        lockSubjects: async (client, token) => {
          await client.query(`
            SELECT u.id FROM users u JOIN company_email_letters l ON l.user_id=u.id
            WHERE l.id=$1 FOR UPDATE OF u
          `, [token.subjectId])
        },
        execute: (client, token, body) => this.answerLetter(client, token, body),
      })
    }
    this.jobs.register({ name: 'letters.expire', lock: 11, run: async client => {
      const expired = await client.query(`
        UPDATE company_email_letters SET status = 'EXPIRED'
        WHERE status = 'SENT' AND sent_at <= now() - interval '14 days'
      `)
      return { expired: expired.rowCount ?? 0 }
    } })
    this.settings.onChange('feature_representation', async (client, before, after) => {
      if (before === true || after !== true) return
      const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE status = 'ACTIVE' AND role IN ('BUYER','SELLER')")
      for (const user of rows) await this.notifications.notify(client, user.id, {
        kind: 'info.representation_enabled', title: 'Укажите роль в сделках',
        body: 'Укажите в профиле, работаете вы как прямая сторона или как агент. Агенту нужно добавить принципала, от чьего имени он публикует объявления.',
        actions: [{ label: 'Открыть профиль', href: '/account#principals', action: 'open' }],
        dedupeKey: 'representation.enabled', channels: ['EMAIL'],
      })
    })
  }

  async state(user: SessionUser) {
    const enabled = await this.settings.enabled('feature_representation')
    if (!enabled) return { enabled: false }
    const profile = await this.profile(this.db, user.id)
    const { rows: [letter] } = await this.db.query(`
      SELECT j.id, j.to_email AS "toEmail", j.sent_at AS "sentAt", j.status, j.delivery_status AS "deliveryStatus"
      FROM company_email_letters j
      WHERE j.user_id = $1 AND j.kind = 'OWN' ORDER BY j.sent_at DESC, j.id DESC LIMIT 1
    `, [user.id])
    let canUseAccountEmail = false
    try { canUseAccountEmail = emailDomainKind(profile.email) === 'CORPORATE' } catch { /* Invalid legacy address. */ }
    return {
      enabled: true, representationMode: profile.representation_mode,
      companyEmail: profile.company_email, companyEmailDomainKind: profile.company_email_domain_kind,
      companyEmailConfirmedAt: profile.company_email_confirmed_at, companyEmailLetter: letter ?? null, canUseAccountEmail,
      agentFee: feeFrom(profile), agentFeeConfirmedAt: profile.agent_fee_confirmed_at,
      agentFeePrincipalSays: profile.agent_fee_principal_says,
    }
  }

  async mode(user: SessionUser, raw: unknown) {
    const mode = oneOf(object(raw).representationMode, ['DIRECT', 'AGENT', 'BOTH'], 'Роль в сделках')
    await this.db.transaction(async client => {
      await this.enabled(client)
      await this.profile(client, user.id, true)
      if (mode === 'AGENT') {
        const active = await client.query(`
          SELECT 1 FROM user_principals WHERE platform_user_id = $1 AND removed_at IS NULL AND confirmed_at IS NOT NULL LIMIT 1
        `, [user.id])
        if (active.rowCount) throw new ConflictException('Вы подтверждены как прямая сторона. Сначала обратитесь к модератору.')
      }
      await client.query('UPDATE users SET representation_mode = $2 WHERE id = $1', [user.id, mode])
    })
    return this.state(user)
  }

  async list(user: SessionUser) {
    await this.enabled(this.db)
    await this.agent(this.db, user.id)
    const { rows } = await this.db.query(`
      SELECT ${principalDetails} FROM user_principals p
      WHERE p.user_id = $1 AND p.removed_at IS NULL ORDER BY p.number
    `, [user.id])
    return { items: rows }
  }

  async add(user: SessionUser, raw: unknown) {
    const body = object(raw)
    const name = displayText(body.name, 'Имя принципала', 2, 160)
    const company = displayText(body.company ?? '', 'Компания принципала', 0, 160)
    const nickname = body.platformNickname === undefined || body.platformNickname === ''
      ? null : displayText(body.platformNickname, 'Ник на площадке', 2, 80)
    return this.db.transaction(async client => {
      await this.enabled(client)
      await this.agent(client, user.id, true)
      const { rows: [numbers] } = await client.query<{ active: number; maximum: number }>(`
        SELECT count(*) FILTER (WHERE removed_at IS NULL)::int AS active, coalesce(max(number),0)::int AS maximum
        FROM user_principals WHERE user_id = $1
      `, [user.id])
      if (numbers.active >= 20 || numbers.maximum >= 999) throw new ConflictException('Достигнут лимит принципалов')
      let platformId = null
      if (nickname) {
        const { rows } = await client.query<{ id: string; representation_mode: string }>(`
          SELECT id, representation_mode FROM users WHERE (lower(display_name) = lower($1) OR lower(username) = lower($1))
            AND role IN ('BUYER','SELLER') AND status = 'ACTIVE' AND email_verified_at IS NOT NULL LIMIT 2
        `, [nickname])
        if (rows.length !== 1) throw new BadRequestException('Укажите однозначный логин действующего участника площадки')
        if (rows[0].id === user.id || rows[0].representation_mode === 'AGENT') throw new BadRequestException('Принципал должен быть прямой стороной')
        platformId = rows[0].id
      }
      const { rows: [created] } = await client.query<{ id: string }>(`
        INSERT INTO user_principals (user_id, number, name, company, platform_user_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [user.id, numbers.maximum + 1, name, company, platformId])
      return this.view(client, user.id, created.id)
    })
  }

  async edit(user: SessionUser, id: string, raw: unknown) {
    const body = object(raw)
    return this.db.transaction(async client => {
      await this.enabled(client)
      await this.agent(client, user.id, true)
      const principal = await this.principal(client, user.id, id, true)
      if (principal.confirmed_at) throw new ConflictException('Принципал подтверждён. Чтобы изменить данные, добавьте нового')
      const name = displayText(body.name ?? principal.name, 'Имя принципала', 2, 160)
      const company = displayText(body.company ?? principal.company, 'Компания принципала', 0, 160)
      if (name !== principal.name || company !== principal.company) {
        await this.expireOpen(client, user.id, principal.id)
        await client.query(`
          UPDATE user_principals SET name = $2, company = $3, email_ack = NULL, denied_at = NULL,
            platform_requested_at = NULL, platform_fee_snapshot = NULL WHERE id = $1
        `, [principal.id, name, company])
      }
      return this.view(client, user.id, principal.id)
    })
  }

  async remove(user: SessionUser, id: string) {
    return this.db.transaction(async client => {
      await this.enabled(client)
      await this.agent(client, user.id, true)
      const principal = await this.principal(client, user.id, id, true)
      const { rows } = await client.query<{ title: string }>(`
        SELECT title FROM listings WHERE principal_id = $1 AND status IN ('ACTIVE','HIDDEN','FROZEN') ORDER BY title LIMIT 20
      `, [principal.id])
      if (rows.length) throw new ConflictException(`Принципал указан в объявлениях: ${rows.map(row => row.title).join(', ')}. Сначала архивируйте их или выберите другого принципала.`)
      await this.expireOpen(client, user.id, principal.id)
      await client.query('UPDATE user_principals SET removed_at = now() WHERE id = $1', [principal.id])
      return { removed: true }
    })
  }

  async sendPrincipal(user: SessionUser, id: string, raw: unknown) {
    const { email, domainKind } = emailAddress(object(raw).email)
    return this.db.transaction(async client => {
      await this.enabled(client)
      const profile = await this.agent(client, user.id, true)
      const principal = await this.principal(client, user.id, id, true)
      if (email === profile.email.toLowerCase()) throw new BadRequestException('Укажите почту представителя компании-принципала, а не свою')
      const letter = await this.sendLetter(client, profile, principal, email, domainKind)
      await client.query('UPDATE user_principals SET email = $2, requested_at = now() WHERE id = $1', [principal.id, email])
      await this.notifications.notify(client, user.id, {
        kind: 'representation.letter_sent', title: 'Запрошено подтверждение принципала',
        body: `Письмо компании отправлено на ${email} (принципал «${principal.name}»).` +
          (domainKind === 'PUBLIC' ? ' Адрес на общем домене. После ответа подтверждение проверит модератор.' : ''),
        actions: [{ label: 'Открыть принципалов', href: '/account#principals', action: 'open' }],
        dedupeKey: 'representation.letter-sent:' + letter.id, channels: [],
      })
      return { letter }
    })
  }

  async ownEmail(user: SessionUser, raw: unknown) {
    const body = object(raw)
    return this.db.transaction(async client => {
      await this.enabled(client)
      const profile = await this.profile(client, user.id, true)
      if (body.useAccountEmail === true) {
        if (emailDomainKind(profile.email) !== 'CORPORATE') throw new BadRequestException('Почта аккаунта находится на общем домене')
        await this.expireOpen(client, user.id, null)
        await client.query(`
          UPDATE users SET company_email = email, company_email_domain_kind = 'CORPORATE', company_email_confirmed_at = now() WHERE id = $1
        `, [user.id])
        return { user: { companyEmail: profile.email, companyEmailDomainKind: 'CORPORATE', companyEmailConfirmedAt: new Date() } }
      }
      const { email, domainKind } = emailAddress(body.email)
      return { letter: await this.sendLetter(client, profile, null, email, domainKind) }
    })
  }

  async fee(user: SessionUser, raw: unknown) {
    const body = object(raw)
    const value = agentFee(body.disclosed, body.kind, body.value, body.payer)
    await this.db.transaction(async client => {
      await this.enabled(client)
      const profile = await this.agent(client, user.id, true)
      if (profile.agent_fee_disclosed !== null && sameFee(value, feeFrom(profile))) return
      await client.query(`
        UPDATE users SET agent_fee_disclosed = $2, agent_fee_kind = $3, agent_fee_value = $4, agent_fee_payer = $5,
          agent_fee_confirmed_at = NULL, agent_fee_principal_says = NULL WHERE id = $1
      `, [user.id, value.disclosed, value.kind, value.value, value.payer])
      await client.query('UPDATE user_principals SET fee_confirmed_at = NULL WHERE user_id = $1 AND fee_confirmed_at IS NOT NULL', [user.id])
    })
    return { user: await this.state(user) }
  }

  async requestPlatform(user: SessionUser, id: string) {
    return this.db.transaction(async client => {
      await this.enabled(client)
      const candidate = await this.principal(client, user.id, id)
      if (!candidate.platform_user_id) throw new ConflictException('Принципал не зарегистрирован на площадке')
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[user.id, candidate.platform_user_id]])
      const profile = await this.agent(client, user.id, true)
      const principal = await this.principal(client, user.id, id, true)
      if (!principal.platform_user_id) throw new ConflictException('Принципал не зарегистрирован на площадке')
      const person = await this.profile(client, principal.platform_user_id)
      if (person.status !== 'ACTIVE' || person.representation_mode === 'AGENT') throw new ConflictException('Принципал должен быть действующей прямой стороной')
      if (principal.platform_requested_at && Date.now() - principal.platform_requested_at.getTime() < 86400000) {
        throw new ConflictException('Запрос уже отправлен. Повторите завтра.')
      }
      const fee = feeFrom(profile)
      const { rows: [updated] } = await client.query<{ requestedAt: Date }>(`
        UPDATE user_principals SET requested_at = now(), platform_requested_at = now(), platform_fee_snapshot = $2
        WHERE id = $1 RETURNING requested_at AS "requestedAt"
      `, [principal.id, fee.disclosed ? JSON.stringify(fee) : null])
      const token = await this.actions.issue(client, { purpose: 'principal.answer', subjectId: principal.id, userId: person.id,
        payload: { agentId: user.id, requestedAt: updated.requestedAt.toISOString() },
        expiresAt: new Date(updated.requestedAt.getTime() + letterDurationMs) })
      await this.notifications.notify(client, person.id, {
        kind: 'representation.request', title: 'Подтверждение представительства',
        body: `Агент ${profile.display_name} указал, что представляет вас. ${feeText(fee)}`,
        payload: { agentId: user.id, principalId: principal.id, canChangeFee: fee.disclosed },
        actions: [{ label: 'Ответить', token, action: 'principal.answer' },
          { label: 'Открыть запрос', href: '/principal-answers?principalId=' + principal.id, action: 'open' }],
        dedupeKey: 'representation.request:' + principal.id + ':' + updated.requestedAt.toISOString(), channels: ['EMAIL'],
      })
      return updated
    })
  }

  async platformView(user: SessionUser, idInput: unknown) {
    await this.enabled(this.db)
    const id = uuid(idInput, 'Принципал')
    const { rows: [row] } = await this.db.query(`
      SELECT p.id AS "principalId", p.user_id AS "agentId", u.display_name AS nickname, p.platform_fee_snapshot AS fee
      FROM user_principals p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND p.platform_user_id = $2 AND p.removed_at IS NULL AND u.status = 'ACTIVE'
        AND p.platform_requested_at >= now() - interval '14 days'
    `, [id, user.id])
    if (!row) throw new NotFoundException('Запрос представительства не найден')
    return row
  }

  async answerPlatform(user: SessionUser, raw: unknown) {
    return this.db.transaction(client => this.answerPlatformInTransaction(client, user.id, raw))
  }

  private async answerPlatformInTransaction(client: PoolClient, userId: string, raw: unknown, requestedAt?: unknown) {
    const body = object(raw)
    const agentId = uuid(body.agentId, 'Агент')
    const id = uuid(body.principalId, 'Принципал')
    const answer = oneOf(body.answer, ['YES', 'NO', 'OTHER'], 'Ответ')
    const value = answer === 'OTHER' ? displayText(body.value, 'Другая цифра', 1, 120) : ''
    await this.enabled(client)
    const candidate = await this.principal(client, agentId, id)
    if (candidate.platform_user_id !== userId) throw new ForbiddenException('Вы не принципал этого агента')
    await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[userId, agentId]])
    const profile = await this.agent(client, agentId, true)
    const principal = await this.principal(client, agentId, id, true)
    if (principal.platform_user_id !== userId) throw new ForbiddenException('Вы не принципал этого агента')
    if (!principal.platform_requested_at || Date.now() - principal.platform_requested_at.getTime() > letterDurationMs ||
      (requestedAt !== undefined && requestedAt !== principal.platform_requested_at.toISOString())) {
      throw new ConflictException('Запрос уже закрыт')
    }
    if (answer === 'OTHER' && !principal.platform_fee_snapshot?.disclosed) throw new BadRequestException('В запросе не указано вознаграждение')
    const person = await this.profile(client, userId)
    if (person.status !== 'ACTIVE' || person.representation_mode === 'AGENT') throw new ForbiddenException('Принципал должен быть прямой стороной')
    await client.query('UPDATE user_principals SET platform_requested_at = NULL, platform_fee_snapshot = NULL WHERE id = $1', [id])
    await this.resolvePrincipal(client, profile, principal, answer !== 'NO' ? 'PLATFORM' : 'DENIED',
      { name: person.display_name }, answer === 'YES' && sameFee(principal.platform_fee_snapshot, feeFrom(profile)), value)
    return { ok: true }
  }

  async adminList(query: Record<string, unknown>) {
    const status = query.status ? oneOf(query.status, ['UNCONFIRMED', 'PUBLIC_ACK', 'DENIED', 'CONFIRMED'], 'Статус принципала') : null
    const { page, limit, offset } = pageParams(query)
    const search = query.q ? str(query.q, 'Поиск', 1, 160) : null
    const filter = `WHERE p.removed_at IS NULL AND ($1::text IS NULL OR
      ($1 = 'UNCONFIRMED' AND p.confirmed_at IS NULL) OR ($1 = 'CONFIRMED' AND p.confirmed_at IS NOT NULL)
      OR ($1 = 'PUBLIC_ACK' AND p.email_ack IS NOT NULL) OR ($1 = 'DENIED' AND p.denied_at IS NOT NULL)) AND
      ($2::text IS NULL OR strpos(lower(concat_ws(' ', p.name, p.company, p.email, u.display_name)), lower($2)) > 0)`
    const [items, count] = await Promise.all([
      this.db.query(`
        SELECT ${principalDetails}, p.user_id AS "userId", u.display_name AS "agentNickname",
          (p.email IS NOT NULL AND split_part(p.email,'@',2) = split_part(u.email,'@',2)) AS "sameDomain"
        FROM user_principals p JOIN users u ON u.id = p.user_id ${filter}
        ORDER BY p.created_at DESC, p.id LIMIT $3 OFFSET $4
      `, [status, search, limit, offset]),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM user_principals p JOIN users u ON u.id = p.user_id ${filter}`, [status, search]),
    ])
    return { items: items.rows, total: count.rows[0].total, page, limit }
  }

  async confirm(staff: SessionUser, userIdInput: string, id: string, raw: unknown) {
    const body = object(raw)
    const userId = uuid(userIdInput, 'Агент')
    const reason = str(body.reason, 'Причина', 3, 500)
    const fee = body.feeConfirmed === undefined ? false : boolean(body.feeConfirmed, 'Проверено вознаграждение')
    return this.db.transaction(async client => {
      await this.enabled(client)
      const profile = await this.agent(client, userId, true)
      const principal = await this.principal(client, userId, id, true)
      await this.resolvePrincipal(client, profile, principal, 'ADMIN', { userId: staff.id }, fee && feeFrom(profile).disclosed)
      await auditExchange(client, staff, 'principals', principal.id, 'confirmed', { confirmedVia: principal.confirmed_via },
        { confirmedVia: 'ADMIN', feeConfirmed: fee }, reason)
      return this.view(client, userId, principal.id)
    })
  }

  private async enabled(client: Queryable) {
    if (!await this.settings.enabled('feature_representation', client)) throw new NotFoundException('Представительство пока недоступно')
  }

  private async profile(client: Queryable, id: string, lock = false) {
    const { rows: [row] } = await client.query<Profile>(`
      SELECT id, email, display_name, company_name, representation_mode, status, ${companyFields}, ${feeFields}
      FROM users WHERE id = $1 AND role IN ('BUYER','SELLER') ${lock ? 'FOR UPDATE' : ''}
    `, [id])
    if (!row) throw new NotFoundException('Профиль участника не найден')
    return row
  }

  private async agent(client: Queryable, id: string, lock = false) {
    const profile = await this.profile(client, id, lock)
    if (!agentModes.includes(profile.representation_mode)) throw new ForbiddenException('Сначала укажите агентскую роль в профиле')
    return profile
  }

  private async principal(client: Queryable, owner: string, input: string, lock = false) {
    const { rows: [row] } = await client.query<Principal>(`
      SELECT * FROM user_principals WHERE user_id = $1 AND id = $2 AND removed_at IS NULL ${lock ? 'FOR UPDATE' : ''}
    `, [owner, uuid(input, 'Принципал')])
    if (!row) throw new NotFoundException('Принципал не найден')
    return row
  }

  private async view(client: Queryable, owner: string, id: string) {
    return (await client.query(`SELECT ${principalDetails} FROM user_principals p WHERE p.user_id = $1 AND p.id = $2`, [owner, id])).rows[0]
  }

  private async expireOpen(client: Queryable, owner: string, principalId: string | null) {
    await client.query(`
      UPDATE company_email_letters SET status = 'REPLACED'
      WHERE user_id = $1 AND principal_id IS NOT DISTINCT FROM $2::uuid AND status = 'SENT'
    `, [owner, principalId])
  }

  private async sendLetter(client: Queryable, profile: Profile, principal: Principal | null, email: string, domainKind: string) {
    const { rows: [setting] } = await client.query<{ value: ThirdPartyLetter }>(
      "SELECT value FROM platform_settings WHERE key='third_party_letter' FOR SHARE",
    )
    if (!setting?.value.approved) {
      throw new ConflictException('Письма компаниям временно недоступны: текст письма не утверждён владельцем площадки')
    }
    const emailHash = hashToken(email.toLowerCase())
    await this.lockRecipient(client, emailHash)
    const suppressed = await client.query('SELECT 1 FROM email_suppressions WHERE email_hash=$1', [emailHash])
    if (suppressed.rowCount) {
      throw new ConflictException('Получатель отказался от писем площадки. Подтвердите принципала другим способом')
    }
    const { rows: [counts] } = await client.query<{ user_count: number; subject_count: number }>(`
      SELECT count(*)::int AS user_count, count(*) FILTER (WHERE principal_id IS NOT DISTINCT FROM $2::uuid)::int AS subject_count
      FROM company_email_letters WHERE user_id = $1 AND sent_at > now() - interval '24 hours'
    `, [profile.id, principal?.id ?? null])
    if (counts.user_count >= 10 || counts.subject_count >= 3) throw new HttpException('Слишком много писем. Попробуйте завтра', 429)
    await this.expireOpen(client, profile.id, principal?.id ?? null)
    const id = randomUUID()
    const token = await this.actions.issue(client, {
      purpose: principal ? 'principal.confirm' : 'company_email.confirm',
      userId: principal ? null : profile.id, subjectId: id, expiresAt: new Date(Date.now() + letterDurationMs),
    })
    const optOut = await this.actions.issue(client, {
      purpose: 'email.optout', subjectId: emailHash, expiresAt: new Date(Date.now() + 365 * 86_400_000),
    })
    const fee = feeFrom(profile)
    const origin = appOrigin() ?? 'http://localhost:' + port('PORT', 3001)
    const values = {
      link: new URL('/a/' + token, origin).href,
      policyUrl: new URL('/info/pd_policy', origin).href,
      optOutUrl: new URL('/a/' + optOut, origin).href,
      agentNickname: profile.display_name, agentCompany: profile.company_name ?? '',
      fee: feeText(fee), expiresDays: '14',
    }
    const subject = principal ? renderLetter(setting.value.subject, values).replace(/[\r\n]/g, ' ')
      : 'hwforai: подтвердите почту компании'
    const body = principal ? renderLetter(setting.value.body, values) : [
      'Подтвердите рабочую почту компании на площадке hwforai. Ссылка действует 14 дней.', values.link,
      'Политика обработки персональных данных: ' + values.policyUrl, 'Отказаться от писем: ' + values.optOutUrl,
    ].join('\n\n')
    const outboxId = await this.notifications.queueEmail(client, {
      to: email, subject, body, respectsOptOut: true, dedupeKey: 'representation.letter:' + id,
    })
    const { rows: [letter] } = await client.query(`
      INSERT INTO company_email_letters (id, kind, user_id, principal_id, to_email, domain_kind, token_hash, outbox_id, fee_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, to_email AS "toEmail", domain_kind AS "domainKind", sent_at AS "sentAt"
    `, [id, principal ? 'PRINCIPAL' : 'OWN', profile.id, principal?.id ?? null, email, domainKind, hashToken(token),
      outboxId, principal && fee.disclosed ? JSON.stringify(fee) : null])
    return letter
  }

  private async lockRecipient(client: Queryable, emailHash: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9624280))', [emailHash])
  }

  private async optOut(client: Queryable, emailHash: string) {
    await this.lockRecipient(client, emailHash)
    await client.query(`
      INSERT INTO email_suppressions(email_hash,reason) VALUES ($1,'RECIPIENT_OPT_OUT') ON CONFLICT DO NOTHING
    `, [emailHash])
    await client.query(`
      UPDATE exchange_email_outbox SET status='SKIPPED',recipient='removed@invalid.invalid',
        subject='Отказ получателя',body='Отказ получателя'
      WHERE status='PENDING' AND respects_opt_out AND encode(sha256(convert_to(lower(recipient),'UTF8')),'hex')=$1
    `, [emailHash])
    await client.query(`
      UPDATE company_email_letters SET status='EXPIRED' WHERE status='SENT'
        AND encode(sha256(convert_to(lower(to_email),'UTF8')),'hex')=$1
    `, [emailHash])
    return { message: 'Площадка больше не будет писать на этот адрес' }
  }

  private async getLetter(client: Queryable, token: ExchangeAction, lock = false) {
    const { rows: [letter] } = await client.query<Letter>(`
      SELECT * FROM company_email_letters WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}
    `, [token.subjectId])
    if (!letter || (letter.kind === 'PRINCIPAL') !== (token.purpose === 'principal.confirm')) throw new NotFoundException('Письмо не найдено')
    if (letter.status === 'EXPIRED') throw new GoneException('Срок письма истёк')
    if (letter.status === 'REPLACED') throw new ConflictException('Это письмо заменено новым. Откройте последнее письмо')
    if (letter.status !== 'SENT') throw new ConflictException('На это письмо уже ответили')
    return letter
  }

  private async describeLetter(client: Queryable, token: ExchangeAction) {
    await this.enabled(client)
    const letter = await this.getLetter(client, token)
    const profile = await this.profile(client, letter.user_id)
    if (profile.status !== 'ACTIVE') throw new ForbiddenException('Профиль недоступен')
    return letter.kind === 'PRINCIPAL' ? {
      title: 'Подтверждение представительства', agent: { nickname: profile.display_name, companyName: profile.company_name },
      fee: letter.fee_snapshot, fields: ['name', 'position', ...(letter.fee_snapshot ? ['feeAnswer', 'feeOtherValue'] : [])],
    } : { title: 'Подтверждение почты компании', fields: [] }
  }

  private async answerLetter(client: Queryable, token: ExchangeAction, raw: unknown) {
    await this.enabled(client)
    const first = await this.getLetter(client, token)
    const profile = await this.profile(client, first.user_id, true)
    if (profile.status !== 'ACTIVE') throw new ForbiddenException('Профиль недоступен')
    const letter = await this.getLetter(client, token, true)
    const body = object(raw)
    const accepted = oneOf(body.answer, ['YES', 'NO'], 'Ответ') === 'YES'
    const named = letter.kind === 'PRINCIPAL' && accepted
    if (named && typeof body.name !== 'string') throw new BadRequestException('Укажите ваше имя')
    const name = named ? displayText(body.name, 'Ваше имя', 2, 120) : ''
    const position = named ? displayText(body.position ?? '', 'Должность', 0, 120) : ''
    const feeAnswer = named && letter.fee_snapshot?.disclosed
      ? oneOf(body.feeAnswer, ['CONFIRMED', 'OTHER'], 'Ответ о вознаграждении') : null
    const feeOther = feeAnswer === 'OTHER' ? displayText(body.feeOtherValue, 'Другая цифра', 1, 120) : ''
    await client.query(`
      UPDATE company_email_letters SET status = $2, answered_at = now(), answered_by_name = $3, answered_by_position = $4,
        fee_answer = $5, fee_other_value = $6 WHERE id = $1
    `, [letter.id, accepted ? 'CONFIRMED' : 'DECLINED', name || null, position || null, feeAnswer, feeOther || null])
    if (letter.kind === 'OWN') {
      if (accepted) await client.query(`
        UPDATE users SET company_email = $2, company_email_domain_kind = $3, company_email_confirmed_at = now() WHERE id = $1
      `, [profile.id, letter.to_email, letter.domain_kind])
      await this.notifications.notify(client, profile.id, {
        kind: 'representation.company_email', title: accepted ? 'Почта компании подтверждена' : 'Почта компании не подтверждена',
        body: accepted ? 'Результат проверки адреса доступен в профиле.' : 'Получатель отклонил подтверждение адреса.',
        actions: [{ label: 'Открыть профиль', href: '/account#company-email', action: 'open' }],
        dedupeKey: 'representation.company-email:' + letter.id, channels: [],
      })
      return { ok: true, result: accepted ? 'CONFIRMED' : 'DECLINED' }
    }
    const principal = await this.principal(client, profile.id, letter.principal_id!, true)
    const result = !accepted ? 'DENIED' : letter.domain_kind === 'CORPORATE' ? 'EMAIL' : 'PUBLIC'
    await this.resolvePrincipal(client, profile, principal, result, {
      name, position, email: letter.to_email, domainKind: letter.domain_kind,
    }, feeAnswer === 'CONFIRMED' && sameFee(letter.fee_snapshot, feeFrom(profile)), feeOther)
    if (result === 'PUBLIC') {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'")
      for (const admin of rows) await this.notifications.notify(client, admin.id, {
        kind: 'representation.public_ack', title: 'Принципал требует проверки',
        body: `Принципал агента ${profile.display_name} ответил с общей почты. Проверьте ответ вручную.`,
        actions: [{ label: 'Открыть очередь', href: '/admin?section=exchange&part=principals', action: 'open' }],
        dedupeKey: 'representation.public-ack:' + letter.id, channels: [],
      })
    }
    return { ok: true, result: !accepted ? 'DECLINED' : result === 'PUBLIC' ? 'ACKNOWLEDGED' : 'CONFIRMED' }
  }

  private async resolvePrincipal(
    client: Queryable, profile: Profile, principal: Principal,
    via: 'EMAIL' | 'PLATFORM' | 'ADMIN' | 'PUBLIC' | 'DENIED', answer: Record<string, unknown>,
    feeConfirmed: boolean, differentFee = '',
  ) {
    const confirmed = via !== 'PUBLIC' && via !== 'DENIED'
    await client.query(`
      UPDATE user_principals SET confirmed_at = CASE WHEN $2 THEN now() END, confirmed_via = $3, confirmed_by = $4,
        email_ack = CASE WHEN $5 THEN $6::jsonb || jsonb_build_object('at', now()) END,
        denied_at = CASE WHEN $7 THEN now() END, fee_confirmed_at = CASE WHEN $2 AND $8 THEN now() END WHERE id = $1
    `, [principal.id, confirmed, confirmed ? via : null, confirmed ? JSON.stringify(answer) : null,
      via === 'PUBLIC', JSON.stringify(answer), via === 'DENIED', feeConfirmed])
    await client.query(`
      UPDATE users SET agent_fee_confirmed_at = (
        SELECT max(fee_confirmed_at) FROM user_principals WHERE user_id = $1 AND removed_at IS NULL
      ), agent_fee_principal_says = coalesce($2, agent_fee_principal_says) WHERE id = $1
    `, [profile.id, differentFee || null])
    const label = via === 'PUBLIC' ? 'Ответ пришёл с общей почты. Модератор проверит его вручную.'
      : via === 'DENIED' ? `Компания не подтвердила принципала «${principal.name}».`
      : via === 'ADMIN' ? `Модератор подтвердил вашего принципала «${principal.name}».`
      : `Представительство принципала «${principal.name}» подтверждено.`
    await this.notifications.notify(client, profile.id, {
      kind: 'representation.answered', title: 'Ответ по принципалу', body: label,
      actions: [{ label: 'Открыть принципалов', href: '/account#principals', action: 'open' }],
      channels: via === 'PUBLIC' || via === 'ADMIN' ? [] : ['EMAIL'],
    })
  }
}
