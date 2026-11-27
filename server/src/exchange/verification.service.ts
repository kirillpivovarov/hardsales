import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { createHash, randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { isStaffRole, type SessionUser, type StaffSession } from '../auth/auth.types'
import { DatabaseService } from '../database/database.service'
import { boolean, escapedSearch, integer, object, oneOf, priceValue, str, uuid } from '../market/market.inputs'
import { auditExchange } from './audit'
import { ExchangeJobs } from './jobs'
import { ExchangeNotifications } from './notifications'
import { PlatformSettings } from './platform-settings'
import { lockTrustStaff } from './trust-access'
import { documentFile, type DocumentUpload } from './trust-files'
import { listingLimit } from './trust-score'
import { TrustService } from './trust.service'
import { verificationRequirements } from './verification-requirements'

const companyKinds = ['COMPANY_CARD', 'SIGNATORY', 'MANDATE', 'PRINCIPAL_LETTER'] as const
const salesProof = ['SERIAL_PHOTO', 'WAREHOUSE_CERT', 'INVOICE', 'WAREHOUSE_VIDEO'] as const
const buyProof = ['LC_LETTER', 'FUNDS_PROOF', 'BANK_LETTER'] as const
const documentKinds = [...companyKinds, ...salesProof, ...buyProof, 'DEAL_DOC', 'OTHER'] as const
const principalKinds: ReadonlySet<string> = new Set(['MANDATE', 'PRINCIPAL_LETTER', 'INVOICE', 'WAREHOUSE_CERT', 'OTHER'])
const letters = 'ABCDEFGHJKMNPRSTUVWXYZ'
const priceBases = ['SELLER_WAREHOUSE', 'DELIVERED'] as const

const documentColumns = `
  d.id, d.user_id AS "userId", d.listing_id AS "listingId", d.principal_id AS "principalId",
  d.deal_id AS "dealId", d.kind, d.file_name AS "fileName", d.mime_type AS "mimeType",
  d.day_code AS "dayCode", d.day_code_ok AS "dayCodeOk", d.status, d.note,
  d.uploaded_at AS "uploadedAt", d.reviewed_at AS "reviewedAt", d.reviewed_by AS "reviewedBy"
`
const userColumns = `
  u.id, u.username, u.display_name AS "displayName", u.role, u.representation_mode AS "representationMode",
  u.verification_level AS level, u.verification_source AS source, u.verification_requested_at AS "verificationRequestedAt",
  u.verified_at AS "verifiedAt", u.verification_rejected_at AS "verificationRejectedAt",
  u.verification_note AS "verificationNote", u.publish_ban_at AS "publishBanAt", u.publish_ban_note AS "publishBanNote",
  u.actuality_suspended_at AS "actualitySuspendedAt", u.link_group AS "linkGroup",
  u.trust_score AS "trustScore", u.trust_factors AS "trustFactors"
`
const dayCodeColumns = `
  c.id, c.user_id AS "userId", c.listing_id AS "listingId", c.code, c.spot_check AS "spotCheck",
  c.issued_at AS "issuedAt", c.expires_at AS "expiresAt", c.result, c.result_at AS "resultAt"
`
type AllowedStaff = StaffSession
type Participant = { id: string; level: number; role: string; status: string; nickname: string }
type Document = {
  id: string; userId: string; listingId: string | null; kind: string; status: string; fileName: string
}

function optionalUuid(value: unknown) {
  return value === undefined || value === null || value === '' ? null : uuid(value)
}

@Injectable()
export class VerificationService implements OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly notify: ExchangeNotifications,
    private readonly jobs: ExchangeJobs,
    private readonly trust: TrustService,
  ) {}

  onApplicationBootstrap() {
    this.jobs.register({ name: 'daycodes.spotcheck', lock: 13, run: client => this.spotChecks(client) })
  }

  private async member(client: PoolClient, id: string): Promise<Participant> {
    const { rows: [user] } = await client.query<Participant>(`
      SELECT id, verification_level AS level, role, status, display_name AS nickname
      FROM users WHERE id = $1 AND role IN ('BUYER','SELLER') FOR UPDATE
    `, [id])
    if (!user) throw new NotFoundException('Профиль участника не найден')
    return user
  }

  async upload(userId: string, file: DocumentUpload | undefined, raw: unknown) {
    await this.trust.requireEnabled()
    const data = object(raw)
    const kind = oneOf(data.kind, documentKinds, 'Документ')
    const listingId = optionalUuid(data.listingId)
    const principalId = optionalUuid(data.principalId)
    const dealId = optionalUuid(data.dealId)
    if (listingId && dealId) throw new BadRequestException('Выберите объявление или сделку')
    if ((kind === 'DEAL_DOC') !== Boolean(dealId)) throw new BadRequestException('Укажите сделку и документ по сделке')
    if (!listingId && kind !== 'SERIAL_PHOTO' && ([...salesProof, ...buyProof] as string[]).includes(kind)) throw new BadRequestException('Укажите объявление для подтверждения')
    if (principalId && !principalKinds.has(kind)) throw new BadRequestException('Для этого документа принципал не указывается')
    if ((kind === 'MANDATE' || kind === 'PRINCIPAL_LETTER') && !principalId) throw new BadRequestException('Укажите принципала')
    const dayCode = data.dayCode ? str(data.dayCode, 'Код дня', 1, 32).toUpperCase() : null
    const content = documentFile(file)
    if (kind === 'SERIAL_PHOTO' && !content.mime.startsWith('image/')) throw new BadRequestException('Загрузите фотографию серийного номера')
    const sha = createHash('sha256').update(content.buffer).digest('hex')

    return this.db.transaction(async client => {
      const user = await this.member(client, userId)
      if (user.status !== 'ACTIVE') throw new ForbiddenException('Профиль недоступен')
      if (principalId && !(await client.query('SELECT 1 FROM user_principals WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', [principalId, userId])).rowCount) {
        throw new NotFoundException('Принципал не найден')
      }
      if (listingId) {
        const { rows: [listing] } = await client.query<{ kind: 'SELL' | 'BUY'; representation: string; principal_id: string | null }>(`
          SELECT kind,representation,principal_id FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE
        `, [listingId, userId])
        if (!listing) throw new NotFoundException('Объявление не найдено')
        if (kind === 'MANDATE') {
          if (listing.kind !== 'SELL' || listing.representation !== 'AGENT' || listing.principal_id !== principalId) {
            throw new BadRequestException('Укажите принципала этого предложения.')
          }
        } else {
          oneOf(kind, listing.kind === 'SELL' ? salesProof : buyProof, 'Подтверждение объявления')
        }
      }
      if (dealId && !(await client.query('SELECT 1 FROM deals WHERE id = $1 AND $2 IN (buyer_id,seller_id)', [dealId, userId])).rowCount) {
        throw new NotFoundException('Сделка не найдена')
      }

      const code = dayCode ? (await client.query<{ id: string; timely: boolean; spot_check: boolean }>(`
        SELECT id, now() <= issued_at + interval '24 hours' AS timely, spot_check
        FROM day_codes WHERE user_id = $1 AND code = $2 AND expires_at > now()
          AND (listing_id IS NULL OR listing_id = $3)
        FOR UPDATE
      `, [userId, dayCode, listingId])).rows[0] : null
      if (dayCode && !code) throw new BadRequestException('Код дня неверен, просрочен или относится к другому объявлению')
      const { rows: [document] } = await client.query<Document>(`
        INSERT INTO verification_documents AS d
          (user_id, listing_id, principal_id, deal_id, kind, file_name, mime_type, content, sha256,
           day_code, day_code_ok, day_code_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${documentColumns}
      `, [userId, listingId, principalId, dealId, kind, content.fileName, content.mime, content.buffer, sha,
        dayCode, dayCode ? Boolean(code) : null, code?.id ?? null])
      if (code && kind === 'SERIAL_PHOTO' && (!code.spot_check || code.timely)) {
        await client.query("UPDATE day_codes SET result = 'PASSED', result_at = now() WHERE id = $1 AND result IS NULL", [code.id])
      }
      if (listingId && kind !== 'MANDATE') await client.query(`
        UPDATE listings SET proof_status = 'PENDING', proof_document_id = $2
        WHERE id = $1 AND proof_status <> 'VERIFIED'
      `, [listingId, document.id])
      if ((companyKinds as readonly string[]).includes(kind)) await client.query(`
        UPDATE users SET verification_requested_at = coalesce(verification_requested_at, now()),
          verification_rejected_at = NULL WHERE id = $1
      `, [userId])
      const { rows: [waiting] } = await client.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM verification_documents WHERE user_id=$1 AND status='PENDING'
      `, [userId])
      const labels: Partial<Record<typeof documentKinds[number], string>> = {
        COMPANY_CARD: 'Карточка компании', SIGNATORY: 'Документ о подписанте', MANDATE: 'Мандат',
        PRINCIPAL_LETTER: 'Письмо принципала', SERIAL_PHOTO: 'Фото серийного номера',
        WAREHOUSE_CERT: 'Справка со склада', INVOICE: 'Счёт или накладная', WAREHOUSE_VIDEO: 'Видео со склада',
        LC_LETTER: 'Письмо об аккредитиве', FUNDS_PROOF: 'Подтверждение средств',
        BANK_LETTER: 'Письмо банка', DEAL_DOC: 'Документ по сделке', OTHER: 'Другой документ',
      }
      await this.notify.notifyStaff(client, {
        kind: 'verification.document_uploaded', title: `${user.nickname} загрузил документ «${labels[kind]}»`,
        body: `Ждут проверки: ${waiting.total}`, channels: ['EMAIL'],
        actions: [{ label: 'Открыть проверку', href: '/admin?section=exchange&part=verification' }],
      })
      return document
    })
  }

  async documents(userId: string, listing?: unknown, deal?: unknown) {
    await this.trust.requireEnabled()
    const listingId = optionalUuid(listing)
    const dealId = optionalUuid(deal)
    return (await this.db.query(`
      SELECT ${documentColumns} FROM verification_documents d
      WHERE d.user_id = $1 AND ($2::uuid IS NULL OR d.listing_id = $2) AND ($3::uuid IS NULL OR d.deal_id = $3)
      ORDER BY d.uploaded_at DESC, d.id LIMIT 100
    `, [userId, listingId, dealId])).rows
  }

  async download(idValue: string, actor: Pick<SessionUser, 'id' | 'role' | 'username'> & Partial<Pick<AllowedStaff, 'sessionHash'>>) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    return this.db.transaction(async client => {
      const staff = isStaffRole(actor.role)
      if (staff) await lockTrustStaff(client, actor as AllowedStaff)
      const { rows: [file] } = await client.query<{ mime_type: string; file_name: string; content: Buffer; user_id: string }>(`
        SELECT mime_type, file_name, content, user_id FROM verification_documents
        WHERE id = $1 AND (user_id = $2 OR $3)
      `, [id, actor.id, staff])
      if (!file) throw new NotFoundException('Документ не найден')
      if (staff) await auditExchange(client, actor as AllowedStaff, 'documents', id, 'file-downloaded', undefined, { userId: file.user_id })
      return file
    })
  }

  async review(actor: AllowedStaff, idValue: string, approved: boolean, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    const input = object(raw)
    const note = approved && !input.note ? null : str(input.note, 'Причина', 3, 1000)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      const owner = (await client.query<{ user_id: string }>('SELECT user_id FROM verification_documents WHERE id = $1', [id])).rows[0]
      if (!owner) throw new NotFoundException('Документ не найден')
      await this.member(client, owner.user_id)
      const { rows: [before] } = await client.query<Document>(`
        SELECT ${documentColumns} FROM verification_documents d WHERE d.id = $1 FOR UPDATE
      `, [id])
      const status = approved ? 'APPROVED' : 'REJECTED'
      if (before.status === status) throw new ConflictException('Решение уже установлено')
      const { rows: [document] } = await client.query<Document>(`
        UPDATE verification_documents AS d SET status = $2, note = $3, reviewed_at = now(), reviewed_by = $4
        WHERE id = $1 RETURNING ${documentColumns}
      `, [id, status, note, actor.id])
      if (document.listingId && document.kind !== 'MANDATE' && approved) await client.query(`
        UPDATE listings SET proof_status = 'VERIFIED', proof_verified_at = now(), proof_document_id = $2 WHERE id = $1
      `, [document.listingId, id])
      if (document.listingId && !approved) await client.query(`
        UPDATE listings SET proof_status = 'NONE', proof_verified_at = NULL, proof_document_id = NULL
        WHERE id = $1 AND proof_document_id = $2
      `, [document.listingId, id])
      await auditExchange(client, actor, 'documents', id, approved ? 'approved' : 'rejected',
        { status: before.status }, { status, userId: document.userId }, note ?? undefined)
      if (!approved) await this.notify.notify(client, document.userId, {
        kind: 'verification.document_rejected', title: 'Документ отклонён',
        body: `Документ «${document.fileName}» отклонён: ${note}`,
        payload: { documentId: id }, channels: ['EMAIL'],
      })
      await this.trust.refresh(client, document.userId)
      return document
    })
  }

  async decide(actor: AllowedStaff, idValue: string, action: 'verify' | 'reject' | 'restrict', raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    const input = object(raw)
    if (action === 'verify' && input.level !== undefined && input.level !== 1) throw new BadRequestException('Уровень вручную подтверждается до 1')
    const note = action === 'verify' && !input.note ? null : str(input.note, 'Причина', 3, 1000)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      const user = await this.member(client, id)
      if (action === 'verify') {
        const strict = await this.settings.get<number>('disclosure_min_level', client) >= 1
        if (strict && !(await verificationRequirements(client, id)).eligible && !note) {
          throw new BadRequestException('Сначала подтвердите документы и полномочия или укажите причину исключения')
        }
        await client.query(`
          UPDATE users SET verification_level = greatest(verification_level, 1), verified_at = now(),
            verification_source = CASE WHEN verification_level=2 THEN 'DEAL' ELSE 'DOCUMENTS' END,
            verification_rejected_at = NULL, verification_note = $2, publish_ban_at = NULL, publish_ban_note = NULL
          WHERE id = $1
        `, [id, note])
        if (!strict) {
          const { rows: accepted } = await client.query<{ id: string }>(`
          UPDATE verification_documents SET status = 'APPROVED', reviewed_by = $3, reviewed_at = now()
          WHERE user_id = $1 AND kind = ANY($2::text[]) AND status = 'PENDING' RETURNING id
          `, [id, companyKinds, actor.id])
          for (const document of accepted) await auditExchange(client, actor, 'documents', document.id, 'approved',
            { status: 'PENDING' }, { status: 'APPROVED', userId: id })
        }
        if (user.level === 0) await this.notifyReadyPartners(client, id)
      } else if (action === 'reject') {
        await client.query("UPDATE users SET verification_rejected_at = now(), verification_note = $2 WHERE id = $1", [id, note])
      } else {
        await client.query(`
          UPDATE users SET verification_level = 0, verified_at = NULL, publish_ban_at = now(), publish_ban_note = $2
          WHERE id = $1
        `, [id, note])
        const { rows: listings } = await client.query<{ id: string }>(`
          UPDATE listings SET status = 'FROZEN', asked_at = NULL, reminded_at = NULL, updated_at = now()
          WHERE owner_id = $1 AND status = 'ACTIVE' RETURNING id
        `, [id])
        for (const listing of listings) await auditExchange(client, actor, 'listings', listing.id, 'status-changed',
          { status: 'ACTIVE' }, { status: 'FROZEN' }, note ?? undefined)
      }
      const rating = await this.trust.refresh(client, id)
      const level = rating?.level ?? user.level
      await auditExchange(client, actor, 'users', id, 'verification-' + action,
        { level: user.level }, { level, restricted: action === 'restrict' }, note ?? undefined)
      const title = action === 'verify' ? 'Документы проверены' : action === 'restrict' ? 'Публикация приостановлена' : 'Проверка документов не пройдена'
      const body = action === 'verify'
        ? `Модератор завершил проверку документов. Лимит объявлений — ${listingLimit(level, rating?.total ?? null) ?? 'без ограничения'}.`
        : action === 'restrict'
          ? `Модератор ограничил публикацию объявлений. Чтобы вернуть доступ, пройдите проверку документов. Причина — ${note}.`
          : `Модератор не подтвердил документы. Причина — ${note}.`
      await this.notify.notify(client, id, { kind: 'verification.' + action, title, body, payload: { level }, channels: ['EMAIL'] })
      return (await client.query(`SELECT ${userColumns} FROM users u WHERE id = $1`, [id])).rows[0]
    })
  }

  async self(userId: string) {
    const { eligible: _eligible, ...state } = await verificationRequirements(this.db, userId)
    return { ...state, canDisclose: state.level >= await this.settings.get<number>('disclosure_min_level') }
  }

  async revoke(actor: AllowedStaff, idValue: string, raw: unknown) {
    const id = uuid(idValue)
    const reason = str(object(raw).reason, 'Причина', 3, 500)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      const before = await this.member(client, id)
      if (!before.level) throw new ConflictException('У участника нет отметки проверки')
      await client.query(`
        UPDATE users SET verification_level=0, verification_source=NULL, verified_at=NULL,
          verification_note=$2, verification_requested_at=NULL WHERE id=$1
      `, [id, reason])
      await this.trust.refresh(client, id)
      await auditExchange(client, actor, 'verification', id, 'revoked', { level: before.level }, { level: 0 }, reason)
      await this.notify.notify(client, id, {
        kind: 'verification.revoked', title: 'Модератор снял отметку проверки',
        body: `${reason}. Чтобы открывать контакты, загрузите документы.`, channels: ['EMAIL'],
      })
      return (await client.query(`SELECT ${userColumns} FROM users u WHERE id=$1`, [id])).rows[0]
    })
  }

  private async notifyReadyPartners(client: PoolClient, userId: string) {
    const { rows } = await client.query<{ partner: string; chat: string; request: string }>(`
      SELECT target.id AS partner, dialog.id AS chat, p.request_id AS request
      FROM telegram_consents p
      JOIN users a ON a.id=p.user_a_id JOIN users b ON b.id=p.user_b_id
      JOIN users target ON target.id=CASE WHEN a.id=$1 THEN b.id ELSE a.id END
      JOIN LATERAL (
        SELECT c.id FROM chats c WHERE
          (c.owner_id=a.id AND c.visitor_id=b.id) OR (c.owner_id=b.id AND c.visitor_id=a.id)
        ORDER BY c.created_at DESC,c.id LIMIT 1
      ) dialog ON true
      WHERE $1 IN (a.id,b.id) AND p.state='REQUESTED' AND target.status='ACTIVE'
        AND p.requested_by=target.id AND p.a_version=a.telegram_version AND p.b_version=b.telegram_version
        AND p.requested_rules_version=(SELECT value #>> '{}' FROM platform_settings WHERE key='rules_version')
    `, [userId])
    for (const { partner, chat, request } of rows) await this.notify.notify(client, partner, {
      kind: 'verification.partner_ready', title: 'Собеседник прошёл проверку документов',
      body: 'Теперь можно открыть контакты.', channels: ['EMAIL'], dedupeKey: `verification.partner_ready:${request}`,
      actions: [{ label: 'Открыть чат', href: `/chats/${chat}` }],
    })
  }

  async dayCode(actor: AllowedStaff, idValue: string, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    const data = object(raw)
    const listingId = optionalUuid(data.listingId)
    const spotCheck = data.spotCheck === undefined ? false : boolean(data.spotCheck, 'Выборочная проверка')
    if (spotCheck && !listingId) throw new BadRequestException('Выберите предложение для проверки')
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      await this.member(client, id)
      const timezone = await this.settings.get<string>('timezone', client)
      if (listingId) {
        const { rows: [listing] } = await client.query<{ eligible: boolean }>(`
          SELECT (kind = 'SELL' AND status = 'ACTIVE'
            AND (confirmed_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date) AS eligible
          FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE
        `, [listingId, id, timezone])
        if (!listing) throw new NotFoundException('Объявление не найдено')
        if (spotCheck && !listing.eligible) throw new ConflictException('Проверка возможна только для предложения, подтверждённого сегодня')
        if (spotCheck && (await client.query(`
          SELECT 1 FROM day_codes WHERE listing_id = $1 AND spot_check AND result IS NULL
        `, [listingId])).rowCount) throw new ConflictException('Проверка этого объявления уже открыта')
      }
      for (let attempt = 0; attempt < 180; attempt++) {
        const prefix = letters[randomInt(letters.length)] + randomInt(1, 10)
        const { rows: [code] } = await client.query<{ id: string; code: string }>(`
          INSERT INTO day_codes AS c (user_id, listing_id, code, spot_check, issued_by, expires_at)
          VALUES ($1, $2, $3 || '-' || to_char(now() AT TIME ZONE $4,'DDMM'), $5, $6, now() + interval '48 hours')
          ON CONFLICT (user_id, code) DO NOTHING RETURNING ${dayCodeColumns}
        `, [id, listingId, prefix, timezone, spotCheck, actor.id])
        if (!code) continue
        await auditExchange(client, actor, 'day-codes', code.id, 'issued', undefined, { userId: id, listingId, spotCheck })
        await this.notify.notify(client, id, {
          kind: 'verification.day_code', title: 'Код дня',
          body: `Код дня: ${code.code}. Сфотографируйте шильдик с серийным номером рядом с листом, на котором написан код. Код действует 48 часов.${spotCheck ? ' Для выборочной проверки загрузите фото в течение 24 часов.' : ''}`,
          payload: { listingId }, channels: ['EMAIL'], dedupeKey: 'day-code:' + code.id,
        })
        return code
      }
      throw new ConflictException('На сегодня закончились доступные коды')
    })
  }

  async queue(actor: AllowedStaff, rawSearch?: unknown) {
    await this.trust.requireEnabled()
    const search = rawSearch === undefined ? null : escapedSearch(rawSearch)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      const { rows: participants } = await client.query(`
        SELECT ${userColumns},
          jsonb_build_object(
            'companyCard', CASE WHEN EXISTS (
              SELECT 1 FROM verification_documents d WHERE d.user_id=u.id AND d.kind='COMPANY_CARD'
                AND d.status='APPROVED' AND d.listing_id IS NULL AND d.principal_id IS NULL
            ) THEN 'PASSED' ELSE 'WAITING' END,
            'signatory', CASE WHEN EXISTS (
              SELECT 1 FROM verification_documents d WHERE d.user_id=u.id AND d.kind='SIGNATORY'
                AND d.status='APPROVED' AND d.listing_id IS NULL AND d.principal_id IS NULL
            ) THEN 'PASSED' ELSE 'WAITING' END,
            'principalEmail', CASE WHEN u.representation_mode='DIRECT' THEN 'NOT_NEEDED'
              WHEN EXISTS (
                SELECT 1 FROM user_principals p WHERE p.user_id=u.id AND p.confirmed_via='EMAIL' AND p.removed_at IS NULL
              ) THEN 'PASSED' ELSE 'WAITING' END
          ) AS requirements,
          jsonb_build_object(
            'dayCode', CASE
              WHEN EXISTS (SELECT 1 FROM day_codes c JOIN verification_documents d ON d.day_code_id = c.id
                WHERE c.user_id = u.id AND d.kind = 'SERIAL_PHOTO' AND d.day_code_ok
                  AND d.uploaded_at <= c.issued_at + interval '24 hours') THEN 'PASSED'
              WHEN EXISTS (SELECT 1 FROM day_codes c WHERE c.user_id = u.id AND c.result = 'FAILED') THEN 'FAILED'
              ELSE 'WAITING' END,
            'principal', CASE WHEN u.representation_mode = 'DIRECT' THEN 'NOT_NEEDED'
              WHEN EXISTS (SELECT 1 FROM user_principals p WHERE p.user_id = u.id AND p.confirmed_at IS NOT NULL AND p.removed_at IS NULL) THEN 'PASSED'
              WHEN EXISTS (SELECT 1 FROM user_principals p WHERE p.user_id = u.id AND p.denied_at IS NOT NULL AND p.removed_at IS NULL) THEN 'FAILED'
              ELSE 'WAITING' END,
            'document', CASE WHEN EXISTS (
              SELECT 1 FROM verification_documents d WHERE d.user_id = u.id AND d.status = 'APPROVED'
                AND (CASE WHEN u.representation_mode = 'DIRECT' THEN d.principal_id IS NULL AND d.kind IN ('COMPANY_CARD','SIGNATORY','INVOICE','WAREHOUSE_CERT')
                  ELSE d.principal_id IS NOT NULL AND d.kind IN ('MANDATE','PRINCIPAL_LETTER','INVOICE','WAREHOUSE_CERT') END)
            ) THEN 'PASSED' ELSE 'WAITING' END
          ) AS chain,
          coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
            SELECT id, title, kind, status, confirmed_at AS "confirmedAt" FROM listings
            WHERE owner_id = u.id AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 50
          ) r), '[]') AS listings
        FROM users u WHERE u.role IN ('BUYER','SELLER') AND u.status = 'ACTIVE'
          AND ($1::text IS NULL OR u.display_name ILIKE $1 OR u.username ILIKE $1 OR u.id::text ILIKE $1)
          AND (
            $1::text IS NOT NULL OR (u.verification_level = 0 AND u.verification_rejected_at IS NULL AND u.verification_requested_at IS NOT NULL)
            OR u.publish_ban_at IS NOT NULL OR u.actuality_suspended_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM verification_documents d WHERE d.user_id = u.id AND d.status = 'PENDING')
          )
        ORDER BY u.verification_requested_at NULLS LAST, u.created_at LIMIT 100
      `, [search])
      const { rows: documents } = await client.query(`
        SELECT ${documentColumns}, u.display_name AS "participantName", l.title AS "listingTitle"
        FROM verification_documents d JOIN users u ON u.id = d.user_id LEFT JOIN listings l ON l.id = d.listing_id
        WHERE d.status = 'PENDING' AND ($1::text IS NULL OR u.display_name ILIKE $1 OR u.username ILIKE $1 OR u.id::text ILIKE $1)
        ORDER BY d.uploaded_at LIMIT 100
      `, [search])
      const { rows: principals } = await client.query(`
        SELECT p.id, p.user_id AS "userId", p.name, p.company, p.confirmed_at AS "confirmedAt",
          p.denied_at AS "deniedAt", u.display_name AS "participantName"
        FROM user_principals p JOIN users u ON u.id = p.user_id WHERE p.removed_at IS NULL
        ORDER BY p.created_at DESC LIMIT 100
      `)
      const { rows: dealsToVerify } = await client.query(`
        SELECT d.id, 'R-' || lpad(s.number::text, greatest(6,length(s.number::text)), '0') AS "disclosureNumber",
          d.disclosure_id AS "disclosureId", d.amount_mismatch AS "amountMismatch",
          d.seller_agreed AS "sellerAgreed", d.buyer_agreed AS "buyerAgreed",
          a.display_name AS "sellerName", b.display_name AS "buyerName",
          coalesce((SELECT jsonb_agg(to_jsonb(doc)) FROM (
            SELECT doc.id, doc.file_name AS "fileName", doc.status FROM verification_documents doc
            WHERE doc.deal_id = d.id AND doc.kind = 'DEAL_DOC' ORDER BY doc.uploaded_at DESC LIMIT 20
          ) doc), '[]') AS documents
        FROM deals d JOIN users a ON a.id = d.seller_id JOIN users b ON b.id = d.buyer_id
          JOIN disclosures s ON s.id = d.disclosure_id
        WHERE d.status = 'EXECUTED' AND d.admin_verified_at IS NULL AND d.admin_rejected_at IS NULL
        ORDER BY d.updated_at LIMIT 100
      `)
      const { rows: dayCodes } = await client.query(`
        SELECT ${dayCodeColumns}, u.display_name AS "participantName", l.title AS "listingTitle"
        FROM day_codes c JOIN users u ON u.id = c.user_id LEFT JOIN listings l ON l.id = c.listing_id
        ORDER BY c.issued_at DESC LIMIT 100
      `)
      await auditExchange(client, actor, 'verification', 'queue', 'viewed', undefined, {
        participants: participants.length, documents: documents.length, deals: dealsToVerify.length,
      })
      return {
        participants, documents, principals, dealsToVerify, dayCodes,
        requiresDocuments: await this.settings.get<number>('disclosure_min_level', client) > 0,
        suspended: participants.filter(user => user.actualitySuspendedAt),
      }
    })
  }

  async penalty(actor: AllowedStaff, idValue: string, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    const input = object(raw)
    const kind = oneOf(input.kind, ['DAY_CODE_SPOT_CHECK_FAILED', 'MISREPRESENTATION_PROVEN', 'OTHER'], 'Вид штрафа')
    const points = integer(input.points, 'Баллы', 1, 100)
    const reason = str(input.reason, 'Причина', 3, 500)
    if ((kind === 'DAY_CODE_SPOT_CHECK_FAILED' && points !== 5) || (kind === 'MISREPRESENTATION_PROVEN' && points !== 10)) {
      throw new BadRequestException('Для этого вида штрафа используется фиксированное число баллов')
    }
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      await this.member(client, id)
      const { rows: [penalty] } = await client.query(`
        INSERT INTO user_penalties (user_id,kind,points,reason,created_by) VALUES ($1,$2,$3,$4,$5)
        RETURNING id::text,kind,points,reason,created_at AS "createdAt"
      `, [id, kind, points, reason, actor.id])
      await auditExchange(client, actor, 'users', id, 'penalty-added', undefined, { penaltyId: penalty.id, kind, points }, reason)
      await this.trust.refresh(client, id)
      return penalty
    })
  }

  async linkGroup(actor: AllowedStaff, idValue: string, raw: unknown) {
    await this.trust.requireEnabled()
    const id = uuid(idValue)
    const input = object(raw)
    const group = input.linkGroup === null ? null : str(input.linkGroup, 'Связанные аккаунты', 1, 40)
    if (group && !/^[a-z0-9-]+$/.test(group)) throw new BadRequestException('Используйте строчные латинские буквы, цифры и дефисы')
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      await this.member(client, id)
      const { rows: [before] } = await client.query<{ link_group: string | null }>('SELECT link_group FROM users WHERE id = $1', [id])
      await client.query('UPDATE users SET link_group = $2 WHERE id = $1', [id, group])
      await this.trust.refresh(client, id)
      await auditExchange(client, actor, 'users', id, 'link-group-changed', { linkGroup: before.link_group }, { linkGroup: group })
      return (await client.query(`SELECT ${userColumns} FROM users u WHERE id = $1`, [id])).rows[0]
    })
  }

  async corridors(actor: AllowedStaff) {
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      return (await client.query(`
        SELECT p.model_id AS "modelId", p.basis, p.min_usd AS "minUsd", p.max_usd AS "maxUsd", p.set_at AS "setAt",
          h.name_ru AS "modelName"
        FROM price_corridors p JOIN hardware_models h ON h.id = p.model_id
        ORDER BY p.model_id, p.basis
      `)).rows
    })
  }

  async saveCorridor(actor: AllowedStaff, rawModel: string, rawBasis: string, raw?: unknown) {
    const modelId = str(rawModel, 'Модель', 1, 100)
    const basis = oneOf(rawBasis, priceBases, 'Базис')
    const input = raw === undefined ? null : object(raw)
    const low = input ? priceValue(input.minUsd, 'Минимум', 0.01) : null
    const high = input ? priceValue(input.maxUsd, 'Максимум', 0.01) : null
    if (low !== null && high !== null && high < low) throw new BadRequestException('Максимум меньше минимума')
    return this.db.transaction(async client => {
      await lockTrustStaff(client, actor)
      if (!input) {
        await client.query('DELETE FROM price_corridors WHERE model_id = $1 AND basis = $2', [modelId, basis])
        await auditExchange(client, actor, 'corridors', modelId + ':' + basis, 'deleted', undefined, { modelId, basis })
        return
      }
      if (!(await client.query('SELECT 1 FROM hardware_models WHERE id = $1', [modelId])).rowCount) {
        throw new NotFoundException('Модель не найдена')
      }
      const { rows: [corridor] } = await client.query(`
        INSERT INTO price_corridors (model_id,basis,min_usd,max_usd,set_by) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (model_id,basis) DO UPDATE SET min_usd = EXCLUDED.min_usd, max_usd = EXCLUDED.max_usd,
          set_by = EXCLUDED.set_by, set_at = now()
        RETURNING model_id AS "modelId", basis, min_usd AS "minUsd", max_usd AS "maxUsd", set_at AS "setAt"
      `, [modelId, basis, low, high, actor.id])
      await auditExchange(client, actor, 'corridors', modelId + ':' + basis, 'edited', undefined, { modelId, basis })
      return corridor
    })
  }

  private async spotChecks(client: PoolClient) {
    if (!await this.settings.enabled('feature_trust_rating', client)) return { failed: 0 }
    const { rows } = await client.query<{ id: string; user_id: string; listing_id: string }>(`
      SELECT id,user_id,listing_id FROM day_codes WHERE spot_check AND result IS NULL
        AND issued_at <= now() - interval '24 hours' ORDER BY user_id, issued_at, id LIMIT 100
    `)
    let failed = 0
    for (const code of rows) {
      await this.member(client, code.user_id)
      const { rows: [listing] } = await client.query<{ id: string; title: string; status: string }>(`
        SELECT id, title, status FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE
      `, [code.listing_id, code.user_id])
      const change = await client.query(`
        UPDATE day_codes SET result = 'FAILED', result_at = now() WHERE id = $1 AND result IS NULL
      `, [code.id])
      if (!change.rowCount) continue
      if (listing?.status === 'ACTIVE') {
        await client.query(`
          UPDATE listings SET status = 'HIDDEN', hidden_at = now(), hidden_reason = 'SPOT_CHECK',
            asked_at = NULL, reminded_at = NULL, updated_at = now() WHERE id = $1
        `, [listing.id])
        await client.query(`
          INSERT INTO moderation_audit (actor,entity,entity_id,action,reason,before_data,after_data)
          VALUES ('system:day-code','listings',$1,'status-changed','Фото с кодом дня не получено',
            '{"status":"ACTIVE"}','{"status":"HIDDEN","hiddenReason":"SPOT_CHECK"}')
        `, [listing.id])
      }
      await client.query(`
        INSERT INTO user_penalties (user_id,kind,points,reason) VALUES ($1,'DAY_CODE_SPOT_CHECK_FAILED',5,$2)
      `, [code.user_id, 'Фото с кодом дня не получено за 24 часа'])
      await this.notify.notify(client, code.user_id, {
        kind: 'verification.spot_check_failed', title: 'Выборочная проверка не пройдена',
        body: `Фото с кодом дня не получено за 24 часа.${listing?.status === 'ACTIVE' ? ` Объявление «${listing.title}» скрыто.` : ''} Минус 5 к рейтингу.`,
        dedupeKey: 'spot-check:' + code.id, payload: { listingId: code.listing_id }, channels: ['EMAIL'],
      })
      await this.trust.refresh(client, code.user_id)
      failed++
    }
    return { failed }
  }
}
