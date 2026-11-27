import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { StaffSession } from '../auth/auth.types'
import { hiddenContactMessage } from '../contact-guard/contact-guard.service'
import { DatabaseService, type Queryable } from '../database/database.service'
import { ExchangeActions } from '../exchange/actions'
import { auditExchange } from '../exchange/audit'
import { ExchangeJobs } from '../exchange/jobs'
import { ExchangeNotifications } from '../exchange/notifications'
import { PlatformSettings } from '../exchange/platform-settings'
import { lockTrustStaff } from '../exchange/trust-access'
import type { DocumentUpload } from '../exchange/trust-files'
import { TrustService } from '../exchange/trust.service'
import { object, oneOf, pageParams, uuid } from '../market/market.inputs'
import { appOrigin, port } from '../config'
import { applyDisputeEffects, penalties, penaltyDescriptions, reverseDisputeEffects, type PriorDecision } from './dispute-decisions'
import { disputeFile, disputeText } from './dispute-files'

export const disputeKinds = {
  MISREPRESENTATION: 'Цена или количество не соответствуют объявлению',
  HIDDEN_MARKUP: 'Скрытая наценка агента',
  NO_CORRESPONDENCE: 'Отказ передать переписку',
  BYPASS: 'Обход площадки после раскрытия',
  FORGERY: 'Подделка документов или фото',
  OTHER: 'Другое',
} as const

const statuses = ['OPENED', 'AWAITING_MATERIALS', 'REVIEW', 'DECIDED', 'REOPENED', 'CLOSED'] as const
type Phase = typeof statuses[number]
type Case = {
  id: string; number: string; disclosure_id: string; deal_id: string | null; opened_by: string; against: string;
  kind: keyof typeof disputeKinds; essence: string; demand: string; status: Phase; opened_at: Date;
  notify_by: Date; notified_at: Date | null; materials_by: Date | null; review_started_at: Date | null;
  decision_by: Date | null; review_until: Date | null; position: string | null; position_at: Date | null;
}
type Viewer = { id: string; staff: boolean }
const notFound = () => new NotFoundException('Спор не найден')
const wrongPhase = () => new ConflictException('Действие недоступно на этом этапе спора')
const href = (id: string) => '/disputes/' + id
const adminHref = (id: string) => '/admin?section=exchange&part=disputes&dispute=' + id
const deadlineColumns = `d.opened_at AS "openedAt", d.notify_by AS "notifyBy", d.notified_at AS "notifiedAt",
  d.materials_by AS "materialsBy", d.decision_by AS "decisionBy", d.review_until AS "reviewUntil"`
const listColumns = `d.id,d.number::text,d.kind,d.status,d.disclosure_id AS "disclosureId",d.deal_id AS "dealId",${deadlineColumns}`
const materialColumns = `id,round,note,file_name AS "fileName",mime_type AS "mimeType",question_id::text AS "questionId",uploaded_at AS "uploadedAt"`

function stage(dispute: Case, ...allowed: Phase[]) {
  if (!allowed.includes(dispute.status)) throw wrongPhase()
}

async function workDeadline(client: Queryable, base: Date, days: number, timezone: string): Promise<Date> {
  const { rows: [row] } = await client.query<{ due: Date }>(`
    WITH local AS (SELECT $1::timestamptz AT TIME ZONE $3 AS stamp)
    SELECT (stamp+g.days*interval '1 day') AT TIME ZONE $3 AS due
    FROM local CROSS JOIN generate_series(1,$2::int*2+7) AS g(days)
    WHERE extract(isodow FROM stamp+g.days*interval '1 day')<=5
    ORDER BY g.days OFFSET $2::int-1 LIMIT 1
  `, [base, days, timezone])
  return row.due
}

function dateLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)
}

function messageId(input: unknown) {
  if (typeof input !== 'string' || !/^[1-9]\d{0,17}$/.test(input)) throw new BadRequestException('Выберите вопрос сотрудника')
  return input
}

@Injectable()
export class DisputesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly settings: PlatformSettings, private readonly jobs: ExchangeJobs,
    private readonly notifications: ExchangeNotifications, private readonly trust: TrustService,
    private readonly actions: ExchangeActions,
  ) {}

  onModuleInit() {
    this.jobs.register({
      name: 'disputes.deadlines', lock: 25, enabled: () => this.settings.enabled('feature_disputes'),
      slot: clock => clock.now.toISOString().slice(0, 16),
      run: client => this.deadlines(client),
    })
    this.actions.register('dispute.review', {
      describe: async (client, action) => {
        const dispute = await this.bannedAppeal(client, action.subjectId, action.payload.participantId)
        return { title: 'Пересмотр спора №' + dispute.number }
      },
      execute: async (client, action, input) => {
        const id = uuid(action.payload.participantId)
        const dispute = await this.bannedAppeal(client, action.subjectId, id)
        const fields = object(input)
        await this.submitReview(client, dispute, id, fields)
        const file = fields.file as DocumentUpload | undefined
        if (file && Buffer.isBuffer(file.buffer)) {
          await this.saveMaterial(client, dispute.id, id, 2, null, null, disputeFile(file))
        }
        return { saved: true }
      },
      lockSubjects: (client, action) => this.lockPair(client, action.subjectId),
    })
  }

  private async requireEnabled(client?: Queryable) {
    if (!await this.settings.enabled('feature_disputes', client)) throw new NotFoundException('Споры пока недоступны')
  }

  async assertAccess(viewer: Viewer, id: string) {
    await this.requireEnabled()
    await this.case(this.db, id, viewer)
  }

  private async lockPair(client: PoolClient, id: string) {
    await client.query(`SELECT u.id FROM disputes d JOIN users u ON u.id IN (d.opened_by,d.against)
      WHERE d.id=$1 ORDER BY u.id FOR NO KEY UPDATE OF u`, [id])
  }

  private async case(client: Queryable, id: string, viewer?: Viewer, lock = false) {
    const { rows: [row] } = await client.query<Case>(`
      SELECT *,number::text AS number FROM disputes WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}
    `, [uuid(id)])
    if (!row || (viewer && !viewer.staff && viewer.id !== row.opened_by && viewer.id !== row.against)) throw notFound()
    return row
  }

  async list(viewer: Viewer, raw: Record<string, unknown>) {
    await this.requireEnabled()
    const { page, limit, offset } = pageParams(raw)
    const status = raw.status ? oneOf(raw.status, statuses, 'Состояние спора') : null
    const disclosureId = raw.disclosureId ? uuid(raw.disclosureId, 'Раскрытие') : null
    const filters = `($1::uuid IS NULL OR $1 IN (d.opened_by,d.against))
      AND ($2::text IS NULL OR d.status=$2) AND ($3::uuid IS NULL OR d.disclosure_id=$3)`
    const params = [viewer.staff ? null : viewer.id, status, disclosureId]
    const timezone = await this.settings.get<string>('timezone')
    const { rows: items } = await this.db.query(`
      SELECT ${listColumns},
        CASE WHEN $1::uuid IS NULL THEN a.display_name END AS "openedByName",
        CASE WHEN $1::uuid IS NULL THEN b.display_name END AS "againstName"
      FROM disputes d JOIN users a ON a.id=d.opened_by JOIN users b ON b.id=d.against
      WHERE ${filters}
      ORDER BY CASE WHEN $1::uuid IS NULL THEN CASE d.status WHEN 'OPENED' THEN d.notify_by
        WHEN 'AWAITING_MATERIALS' THEN d.materials_by WHEN 'REVIEW' THEN d.decision_by WHEN 'REOPENED' THEN d.decision_by END END NULLS LAST,
        d.opened_at DESC,d.number DESC LIMIT $4 OFFSET $5
    `, [...params, limit, offset])
    const { rows: [count] } = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM disputes d WHERE ${filters}`, params)
    return { items, total: count.total, page, limit, timezone }
  }

  async disclosureDeals(actor: string, input: string) {
    await this.requireEnabled()
    const id = uuid(input, 'Раскрытие')
    const access = await this.db.query('SELECT 1 FROM disclosures WHERE id=$1 AND $2 IN(user_a_id,user_b_id)', [id, actor])
    if (!access.rowCount) throw new NotFoundException('Раскрытие не найдено')
    const { rows: items } = await this.db.query(`
      SELECT d.id,coalesce(s.title,b.title,'Сделка') AS title,d.created_at AS "createdAt"
      FROM deals d LEFT JOIN listings s ON s.id=d.sell_listing_id LEFT JOIN listings b ON b.id=d.buy_listing_id
      WHERE d.disclosure_id=$1 AND $2 IN(d.seller_id,d.buyer_id)
      ORDER BY d.created_at DESC,d.id LIMIT 100
    `, [id, actor])
    return { items }
  }

  async detail(viewer: Viewer, input: string, staff?: StaffSession) {
    await this.requireEnabled()
    return this.db.transaction(async client => {
      if (staff) await lockTrustStaff(client, staff)
      const row = await this.case(client, input, viewer)
      if (staff) await auditExchange(client, staff, 'disputes', row.id, 'viewed')
      return this.view(client, row, viewer)
    })
  }

  private async view(client: PoolClient, row: Case, viewer: Viewer) {
    const timezone = await this.settings.get<string>('timezone', client)
    const { rows: parties } = await client.query<{ id: string; nickname: string; link_group: string | null }>(
      'SELECT id,display_name AS nickname,link_group FROM users WHERE id IN ($1,$2)',
      [row.opened_by, row.against],
    )
    const { rows: materials } = await client.query(`
      SELECT ${materialColumns},user_id=$2 AS mine,user_id AS "userId" FROM dispute_materials
      WHERE dispute_id=$1 ORDER BY uploaded_at,id
    `, [row.id, viewer.id])
    const { rows: messages } = await client.query(`
      SELECT m.id::text,m.body,m.round,m.reply_to::text AS "replyTo",m.created_at AS "createdAt",
        m.from_user=$2 AS mine, u.role IN ('ADMIN','MODERATOR') AS staff,
        CASE WHEN $3 THEN m.to_user END AS "toUserId", CASE WHEN $3 THEN u.username END AS "fromName"
      FROM dispute_messages m JOIN users u ON u.id=m.from_user
      WHERE m.dispute_id=$1 AND ($3 OR $2 IN (m.from_user,m.to_user)) ORDER BY m.id
    `, [row.id, viewer.id, viewer.staff])
    const { rows: decisions } = await client.query<{
      decidedBy?: string; round: number; loserId: string | null; penalty: string; rationale: string; decidedAt: Date;
    }>(`
      SELECT d.id,d.round,d.loser_id AS "loserId",d.penalty,d.rationale,d.decided_at AS "decidedAt",
        CASE WHEN $2 THEN d.same_reviewer ELSE false END AS "sameReviewer",
        CASE WHEN $2 THEN d.decided_by END AS "decidedBy",CASE WHEN $2 THEN u.username END AS "reviewerName"
      FROM dispute_decisions d JOIN users u ON u.id=d.decided_by WHERE dispute_id=$1 ORDER BY round
    `, [row.id, viewer.staff])
    const { rows: reviews } = await client.query(`
      SELECT id, user_id AS "userId",text,submitted_at AS "submittedAt" FROM dispute_reviews
      WHERE dispute_id=$1 ORDER BY submitted_at,id
    `, [row.id])
    const { rows: listings } = viewer.staff ? await client.query(`
      SELECT DISTINCT l.id,l.title,l.owner_id AS "ownerId" FROM disclosures d
      LEFT JOIN deals chosen ON chosen.id=$2
      JOIN listings l ON l.id IN (d.listing_id,d.counter_listing_id,chosen.sell_listing_id,chosen.buy_listing_id)
      WHERE d.id=$1 AND l.owner_id IN (d.user_a_id,d.user_b_id) ORDER BY l.title,l.id
    `, [row.disclosure_id, row.deal_id]) : { rows: [] }
    const prior = decisions[0]
    const restriction = viewer.staff && ['REVIEW', 'REOPENED'].includes(row.status)
      ? await this.reviewerRestriction(client, row, viewer.id, prior?.decidedBy) : null
    return {
      id: row.id, number: row.number, disclosureId: row.disclosure_id, dealId: row.deal_id,
      openedBy: row.opened_by, against: row.against, kind: row.kind, essence: row.essence, demand: row.demand,
      status: row.status, openedAt: row.opened_at, notifyBy: row.notify_by, notifiedAt: row.notified_at,
      materialsBy: row.materials_by, decisionBy: row.decision_by, reviewUntil: row.review_until,
      position: row.position, positionAt: row.position_at, timezone,
      parties: parties.map(({ id, nickname }) => ({ id, nickname })), materials, messages, decisions, reviews, listings,
      restriction, canReview: !viewer.staff && ['DECIDED', 'REOPENED'].includes(row.status) && decisions.length === 1 &&
        Boolean(row.review_until && row.review_until > new Date()) && !reviews.some(review => review.userId === viewer.id),
    }
  }

  async open(actor: string, input: unknown) {
    await this.requireEnabled()
    const body = object(input)
    const disclosureId = uuid(body.disclosureId, 'Раскрытие')
    return this.db.transaction(async client => {
      const { rows: [source] } = await client.query<{ partner: string }>(`
        SELECT CASE WHEN user_a_id=$2 THEN user_b_id ELSE user_a_id END AS partner
        FROM disclosures WHERE id=$1 AND $2 IN (user_a_id,user_b_id)
      `, [disclosureId, actor])
      if (!source) throw new ForbiddenException('Открыть спор может сторона раскрытия')
      const users = await client.query<{ id: string; status: string }>(`
        SELECT id,status FROM users WHERE id IN ($1,$2) ORDER BY id FOR NO KEY UPDATE
      `, [actor, source.partner])
      if (users.rows.find(user => user.id === actor)?.status !== 'ACTIVE') throw new ForbiddenException('Профиль недоступен')
      const dealId = body.dealId == null || body.dealId === '' ? null : uuid(body.dealId, 'Сделка')
      const kind = oneOf(body.kind, Object.keys(disputeKinds) as Array<keyof typeof disputeKinds>, 'Причина спора')
      const essence = disputeText(body.essence, 'Суть спора', 20, 4000)
      const demand = disputeText(body.demand, 'Требование', 5, 1000)
      if (dealId && !(await client.query(
        'SELECT 1 FROM deals WHERE id=$1 AND disclosure_id=$2 FOR KEY SHARE', [dealId, disclosureId],
      )).rowCount) throw new BadRequestException('Выберите сделку этого раскрытия')
      const clock = await this.jobs.clock(client)
      const notifyBy = await workDeadline(client, clock.now, 1, clock.timezone)
      const { rows: [row] } = await client.query<Case>(`
        INSERT INTO disputes(disclosure_id,deal_id,opened_by,against,kind,essence,demand,notify_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (disclosure_id,opened_by) WHERE status NOT IN ('DECIDED','CLOSED') DO NOTHING
        RETURNING *,number::text AS number
      `, [disclosureId, dealId, actor, source.partner, kind, essence, demand, notifyBy])
      if (!row) throw new ConflictException('По этому раскрытию у вас уже есть открытый спор')
      await this.event(client, row, actor, 'Открыт спор ' + row.number + ': ' + disputeKinds[kind])
      await this.notice(client, row, actor, 'received', 'Спор №' + row.number + ' открыт',
        'Сотрудник сообщит второй стороне в течение одного рабочего дня.')
      await this.notifications.notifyStaff(client, {
        kind: 'dispute.opened', title: 'Открыт спор №' + row.number, body: disputeKinds[kind],
        actions: [{ label: 'Открыть спор', href: adminHref(row.id) }], dedupeKey: 'dispute.opened:' + row.id,
      })
      return this.view(client, row, { id: actor, staff: false })
    })
  }

  async notify(staff: StaffSession, id: string) {
    return this.staffUpdate(staff, id, (client, row) => this.notifyParty(client, row, staff))
  }

  async startReview(staff: StaffSession, id: string) {
    return this.staffUpdate(staff, id, (client, row) => this.beginReview(client, row, staff))
  }

  private async staffAction<T>(staff: StaffSession, id: string, action: (client: PoolClient, row: Case) => Promise<T>) {
    await this.requireEnabled()
    const target = uuid(id)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, staff)
      await this.lockPair(client, target)
      const row = await this.case(client, target, undefined, true)
      return action(client, row)
    })
  }

  private staffUpdate(staff: StaffSession, id: string, action: (client: PoolClient, row: Case) => Promise<unknown>) {
    return this.staffAction(staff, id, async (client, row) => {
      await action(client, row)
      return this.view(client, await this.case(client, row.id), { id: staff.id, staff: true })
    })
  }

  private async notifyParty(client: PoolClient, row: Case, staff?: StaffSession) {
    stage(row, 'OPENED')
    const clock = await this.jobs.clock(client)
    const due = await workDeadline(client, clock.now, 3, clock.timezone)
    await client.query(`UPDATE disputes SET status='AWAITING_MATERIALS',notified_at=now(),materials_by=$2
      WHERE id=$1`, [row.id, due])
    const title = 'Нужны материалы по спору №' + row.number
    const deadline = dateLabel(due, clock.timezone)
    await this.notice(client, row, row.against, 'materials', title,
      row.essence + '\n\nТребование: ' + row.demand + '\n\nДайте позицию и передайте материалы до ' + deadline +
      '. Отказ передать переписку может стать основанием для решения в пользу другой стороны.')
    await this.notice(client, row, row.opened_by, 'materials', title, 'Передайте материалы до ' + deadline + '.')
    if (staff) await auditExchange(client, staff, 'disputes', row.id, 'notified')
  }

  private async beginReview(client: PoolClient, row: Case, staff?: StaffSession) {
    stage(row, 'AWAITING_MATERIALS')
    const clock = await this.jobs.clock(client)
    const due = await workDeadline(client, clock.now, 5, clock.timezone)
    await client.query(`UPDATE disputes SET status='REVIEW',review_started_at=now(),decision_by=$2,assigned_to=$3
      WHERE id=$1`, [row.id, due, staff?.id ?? null])
    if (staff) await auditExchange(client, staff, 'disputes', row.id, 'review-started')
  }

  async position(actor: string, id: string, input: unknown) {
    return this.participantAction(actor, id, async (client, row) => {
      if (row.against !== actor) throw new ForbiddenException('Позицию даёт вторая сторона спора')
      stage(row, 'AWAITING_MATERIALS')
      if (row.materials_by && row.materials_by <= new Date()) throw wrongPhase()
      const text = disputeText(object(input).text, 'Позиция', 1, 4000)
      await client.query('UPDATE disputes SET position=$2,position_at=now() WHERE id=$1', [row.id, text])
      return this.view(client, await this.case(client, row.id), { id: actor, staff: false })
    })
  }

  async material(actor: string, id: string, input: unknown, upload?: DocumentUpload) {
    return this.participantAction(actor, id, async (client, row) => {
      const { questionId, note } = object(input)
      const question = questionId == null || questionId === '' ? null : messageId(questionId)
      const editable = row.status === 'OPENED' && actor === row.opened_by ||
        row.status === 'AWAITING_MATERIALS' && Boolean(row.materials_by && row.materials_by > new Date())
      if (!editable) {
        stage(row, 'REVIEW', 'REOPENED')
        const appealMaterials = row.status === 'REOPENED' && !question && (await client.query(
          'SELECT 1 FROM dispute_reviews WHERE dispute_id=$1 AND user_id=$2', [row.id, actor],
        )).rowCount
        if (!appealMaterials) await this.question(client, row, actor, question)
      } else if (question) throw new BadRequestException('Вопрос сотрудника недоступен')
      const round = row.status === 'REOPENED' ? 2 : 1
      const description = note == null || note === '' ? null : disputeText(note, 'Комментарий к материалу', 1, 2000)
      const file = disputeFile(upload)
      if (!description && !file) throw new BadRequestException('Опишите материал или приложите файл')
      return this.saveMaterial(client, row.id, actor, round, question, description, file)
    })
  }

  private async saveMaterial(client: PoolClient, disputeId: string, actor: string, round: number, question: string | null,
    description: string | null, file: ReturnType<typeof disputeFile>) {
    const { rows: [result] } = await client.query(`
      INSERT INTO dispute_materials(dispute_id,user_id,round,question_id,note,file_name,mime_type,content,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${materialColumns}
    `, [disputeId, actor, round, question, description, file?.fileName ?? null, file?.mime ?? null, file?.buffer ?? null,
      file ? createHash('sha256').update(file.buffer).digest('hex') : null])
    return result
  }

  async download(viewer: Viewer, id: string, material: string, staff?: StaffSession) {
    await this.requireEnabled()
    return this.db.transaction(async client => {
      if (staff) await lockTrustStaff(client, staff)
      const row = await this.case(client, id, viewer)
      const { rows: [file] } = await client.query<{ file_name: string; mime_type: string; content: Buffer }>(`
        SELECT file_name,mime_type,content FROM dispute_materials WHERE dispute_id=$1 AND id=$2 AND content IS NOT NULL
      `, [row.id, uuid(material, 'Материал')])
      if (!file) throw new NotFoundException('Материал не найден')
      if (staff) await auditExchange(client, staff, 'disputes', row.id, 'material-downloaded', null, { materialId: material })
      return file
    })
  }

  async ask(staff: StaffSession, id: string, input: unknown) {
    return this.staffAction(staff, id, async (client, row) => {
      stage(row, 'REVIEW', 'REOPENED')
      const body = object(input)
      const toUserId = uuid(body.toUserId, 'Адресат')
      if (![row.opened_by, row.against].includes(toUserId)) throw new BadRequestException('Выберите сторону спора')
      const text = disputeText(body.body, 'Вопрос', 1, 4000)
      const { rows: [message] } = await client.query<{ id: string; createdAt: Date; body: string; round: number }>(`
        INSERT INTO dispute_messages(dispute_id,from_user,to_user,body,round)
        VALUES($1,$2,$3,$4,$5) RETURNING id::text,created_at AS "createdAt",body,round
      `, [row.id, staff.id, toUserId, text, row.status === 'REOPENED' ? 2 : 1])
      await this.notice(client, row, toUserId, 'question', 'Вопрос по спору №' + row.number, text, message.id)
      await auditExchange(client, staff, 'disputes', row.id, 'question-sent', null, { messageId: message.id, toUserId })
      return { ...message, toUserId, staff: true, mine: true, replyTo: null }
    })
  }

  private async question(client: PoolClient, row: Case, actor: string, id: string | null) {
    const { rows: [question] } = await client.query<{ from_user: string }>(`
      SELECT m.from_user FROM dispute_messages m JOIN users u ON u.id=m.from_user
      WHERE m.dispute_id=$1 AND m.id=$2 AND m.to_user=$3 AND m.round=$4 AND m.reply_to IS NULL
        AND u.role IN ('ADMIN','MODERATOR')
    `, [row.id, id, actor, row.status === 'REOPENED' ? 2 : 1])
    if (!question) throw new ConflictException('На этом этапе материалы и ответы принимаются по вопросу сотрудника')
    return question
  }

  async reply(actor: string, id: string, input: unknown) {
    return this.participantAction(actor, id, async (client, row) => {
      stage(row, 'REVIEW', 'REOPENED')
      const body = object(input)
      const questionId = messageId(body.replyTo ?? body.questionId)
      const question = await this.question(client, row, actor, questionId)
      const text = disputeText(body.body, 'Ответ', 1, 4000)
      const { rows: [result] } = await client.query(`
        INSERT INTO dispute_messages(dispute_id,from_user,to_user,body,round,reply_to)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id::text,body,round,reply_to::text AS "replyTo",true AS mine,created_at AS "createdAt"
      `, [row.id, actor, question.from_user, text, row.status === 'REOPENED' ? 2 : 1, questionId])
      return result
    })
  }

  async withdraw(actor: string, id: string) {
    return this.participantAction(actor, id, async (client, row) => {
      if (row.opened_by !== actor) throw new ForbiddenException('Отозвать спор может подавшая его сторона')
      stage(row, 'OPENED', 'AWAITING_MATERIALS', 'REVIEW')
      await client.query("UPDATE disputes SET status='CLOSED' WHERE id=$1", [row.id])
      await this.event(client, row, actor, 'Спор ' + row.number + ' отозван')
      return this.view(client, await this.case(client, row.id), { id: actor, staff: false })
    })
  }

  async appeal(actor: string, id: string, input: unknown) {
    return this.participantAction(actor, id, async (client, row) => {
      await this.submitReview(client, row, actor, input)
      return this.view(client, await this.case(client, row.id), { id: actor, staff: false })
    })
  }

  private async bannedAppeal(client: PoolClient, id: string, input: unknown) {
    await this.requireEnabled(client)
    const actor = uuid(input)
    const row = await this.case(client, id, { id: actor, staff: false }, true)
    const target = await client.query(`
      SELECT 1 FROM users u JOIN dispute_decisions d ON d.loser_id=u.id
      WHERE d.dispute_id=$1 AND d.round=1 AND d.penalty IN ('BYPASS','FORGERY')
        AND u.id=$2 AND u.status='BANNED' AND u.deleted_at IS NULL
    `, [id, actor])
    if (!target.rowCount) throw notFound()
    return row
  }

  private async submitReview(client: PoolClient, row: Case, actor: string, input: unknown) {
    stage(row, 'DECIDED', 'REOPENED')
    const clock = await this.jobs.clock(client)
    if (!row.review_until || row.review_until <= clock.now) throw new ConflictException('Срок пересмотра истёк')
    const text = disputeText(object(input).text, 'Новые доводы', 20, 4000)
    if (row.status === 'DECIDED' && (await client.query(`
      SELECT 1 FROM disputes WHERE disclosure_id=$1 AND opened_by=$2 AND id<>$3
        AND status NOT IN ('DECIDED','CLOSED')
    `, [row.disclosure_id, row.opened_by, row.id])).rowCount) {
      throw new ConflictException('По этому раскрытию уже рассматривается другой спор')
    }
    const result = await client.query(`
      INSERT INTO dispute_reviews(dispute_id,user_id,text) VALUES($1,$2,$3)
      ON CONFLICT(dispute_id,user_id) DO NOTHING
    `, [row.id, actor, text])
    if (!result.rowCount) throw new ConflictException('Вы уже подавали запрос на пересмотр')
    if (row.status === 'DECIDED') {
      const due = await workDeadline(client, clock.now, 5, clock.timezone)
      await client.query("UPDATE disputes SET status='REOPENED',decision_by=$2,assigned_to=NULL WHERE id=$1", [row.id, due])
    }
    await this.event(client, row, actor, 'Подан запрос на пересмотр спора ' + row.number)
    await this.notifications.notifyStaff(client, {
      kind: 'dispute.reopened', title: 'Запрошен пересмотр спора №' + row.number, body: 'Поданы новые доводы.',
      actions: [{ label: 'Открыть спор', href: adminHref(row.id) }], dedupeKey: 'dispute.reopened:' + row.id + ':' + actor,
    })
    await this.notice(client, row, actor === row.opened_by ? row.against : row.opened_by, 'review',
      'Запрошен пересмотр спора №' + row.number, 'Вторая сторона подала новые доводы.', actor)
  }

  private async participantAction<T>(actor: string, id: string, action: (client: PoolClient, row: Case) => Promise<T>) {
    await this.requireEnabled()
    const target = uuid(id)
    return this.db.transaction(async client => {
      await this.lockPair(client, target)
      const row = await this.case(client, target, { id: actor, staff: false }, true)
      if (!(await client.query("SELECT 1 FROM users WHERE id=$1 AND status='ACTIVE'", [actor])).rowCount) {
        throw new ForbiddenException('Профиль недоступен')
      }
      return action(client, row)
    })
  }

  private async reviewerRestriction(client: Queryable, row: Case, staff: string, previous?: string, lock = false) {
    const { rows: groups } = await client.query<{ id: string; link_group: string | null }>(
      'SELECT id,link_group FROM users WHERE id IN ($1,$2,$3)', [row.opened_by, row.against, staff],
    )
    const group = groups.find(item => item.id === staff)?.link_group
    const excluded = groups.filter(item => item.id !== staff && item.link_group).map(item => item.link_group)
    if (group && excluded.includes(group)) return 'Вы связаны со стороной спора: решает другой сотрудник'
    if (row.status !== 'REOPENED' || staff !== previous) return null
    const { rowCount } = await client.query(`
      SELECT 1 FROM users WHERE role IN ('ADMIN','MODERATOR') AND status='ACTIVE' AND email_verified_at IS NOT NULL AND NOT must_change_password
        AND id<>$1 AND (link_group IS NULL OR link_group<>ALL($2::text[]))
      LIMIT 1 ${lock ? 'FOR SHARE' : ''}
    `, [staff, excluded])
    return rowCount ? 'Пересмотр должен провести другой сотрудник' : null
  }

  async decide(staff: StaffSession, id: string, input: unknown) {
    return this.staffUpdate(staff, id, async (client, row) => {
      stage(row, 'REVIEW', 'REOPENED')
      const round = row.status === 'REOPENED' ? 2 : 1
      const { rows: [prior] } = round === 2 ? await client.query<PriorDecision>(`
        SELECT loser_id,decided_by,listing_id,penalty,effects FROM dispute_decisions WHERE dispute_id=$1 AND round=1
      `, [row.id]) : { rows: [] }
      const restriction = await this.reviewerRestriction(client, row, staff.id, prior?.decided_by, true)
      if (restriction) throw new ForbiddenException(restriction)
      const body = object(input)
      const penalty = oneOf(body.penalty, penalties, 'Решение')
      const rationale = disputeText(body.rationale, 'Обоснование', 20, 4000)
      const loserId = body.loserId == null || body.loserId === '' ? null : uuid(body.loserId, 'Проигравшая сторона')
      if (penalty === 'NONE' ? loserId : !loserId || ![row.against, row.opened_by].includes(loserId)) {
        throw new BadRequestException('Выберите проигравшую сторону или отклоните спор без наказания')
      }
      const explicitListing = body.listingId == null || body.listingId === '' ? null : uuid(body.listingId, 'Объявление')
      let listingId: string | null = null
      if (penalty === 'MISREPRESENTATION' && loserId) {
        const { rows: [listing] } = await client.query<{ id: string }>(`
          SELECT l.id FROM disclosures d LEFT JOIN deals chosen ON chosen.id=$4
          JOIN listings l ON CASE WHEN $3::uuid IS NOT NULL THEN l.id=$3
            ELSE l.id IN (chosen.sell_listing_id,chosen.buy_listing_id,d.listing_id,d.counter_listing_id) END
          WHERE d.id=$1 AND l.owner_id=$2
          ORDER BY CASE l.id WHEN chosen.sell_listing_id THEN 1 WHEN chosen.buy_listing_id THEN 1 WHEN d.listing_id THEN 2 ELSE 3 END,l.id LIMIT 1
        `, [row.disclosure_id, loserId, explicitListing, row.deal_id])
        if (!listing) throw new BadRequestException('Укажите объявление проигравшей стороны')
        listingId = listing.id
      }
      const kept = prior && prior.loser_id === loserId && prior.penalty === penalty && prior.listing_id === listingId
      if (prior && !kept) await reverseDisputeEffects(client, staff, row, prior)
      const effects = kept ? prior.effects : loserId ? await applyDisputeEffects(client, staff, row, loserId, penalty, listingId) : {}
      await client.query(`
        INSERT INTO dispute_decisions(dispute_id,round,decided_by,loser_id,penalty,rationale,listing_id,same_reviewer,effects)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [row.id, round, staff.id, loserId, penalty, rationale, listingId, prior?.decided_by === staff.id, JSON.stringify(effects)])
      const timezone = await this.settings.get<string>('timezone', client)
      const { rows: [state] } = await client.query<{ review_until: Date | null }>(`
        UPDATE disputes SET status='DECIDED',
          review_until=CASE WHEN $2=1 THEN ((now() AT TIME ZONE $4)+interval '7 days') AT TIME ZONE $4 END,
          assigned_to=$3 WHERE id=$1 RETURNING review_until
      `, [row.id, round, staff.id, timezone])
      await this.event(client, row, null, 'Решение по спору ' + row.number + ': ' + penaltyDescriptions[penalty])
      await auditExchange(client, staff, 'disputes', row.id, 'decided', null, { round, loserId, penalty, listingId }, rationale)
      for (const userId of new Set([row.opened_by, row.against])) {
        await this.notice(client, row, userId, 'decided', 'Решение по спору №' + row.number, rationale, String(round))
      }
      if (loserId && (penalty === 'BYPASS' || penalty === 'FORGERY')) {
        const { rows: [user] } = await client.query<{ email: string; deleted_at: Date | null }>(
          'SELECT email,deleted_at FROM users WHERE id=$1', [loserId],
        )
        if (!user.deleted_at) {
          const token = state.review_until ? await this.actions.issue(client, {
            purpose: 'dispute.review', subjectId: row.id, payload: { participantId: loserId }, expiresAt: state.review_until,
          }) : null
          const action = token ? '\n\nПодать новые доводы в течение семи суток: ' + new URL('/a/' + token, appOrigin() ?? 'http://localhost:' + port('PORT', 3001)).href : ''
          await this.notifications.queueEmail(client, {
            to: user.email, subject: 'Решение по спору №' + row.number, body: rationale + action,
            dedupeKey: `dispute.decided.blocked:${row.id}:${round}`,
          })
        }
      }
      for (const target of [...new Set([prior?.loser_id, loserId].filter((value): value is string => Boolean(value)))].sort()) {
        await this.trust.refresh(client, target)
      }
    })
  }

  async evidence(staff: StaffSession, id: string, query: Record<string, unknown>) {
    await this.requireEnabled()
    const { page, offset, limit } = pageParams(query, 50)
    return this.db.transaction(async client => {
      await lockTrustStaff(client, staff)
      const row = await this.case(client, id)
      const { rows: chats } = await client.query<{ id: string; title: string }>(`
        SELECT c.id,l.title FROM chats c JOIN listings l ON l.id=c.listing_id
        WHERE (c.visitor_id=$1 AND c.owner_id=$2) OR (c.visitor_id=$2 AND c.owner_id=$1)
        ORDER BY c.created_at DESC,c.id
      `, [row.opened_by, row.against])
      const requested = query.chatId === undefined ? chats[0]?.id : uuid(query.chatId, 'Чат')
      if (requested && !chats.some(chat => chat.id === requested)) throw new NotFoundException('Чат пары не найден')
      const hide = staff.role !== 'ADMIN' && await this.settings.enabled('feature_disclosure_journal', client)
      const { rows: items } = await client.query(`
        SELECT m.id::text,CASE WHEN $4 AND m.hidden_for_peer THEN $5 ELSE m.body END AS body,
          u.display_name AS nickname,m.created_at AS "createdAt"
        FROM chat_messages m JOIN users u ON u.id=m.sender_id
        WHERE m.chat_id=$1 ORDER BY m.id DESC LIMIT $2 OFFSET $3
      `, [requested ?? null, limit, offset, hide, hiddenContactMessage])
      const { rows: [count] } = await client.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM chat_messages WHERE chat_id=$1', [requested ?? null],
      )
      await auditExchange(client, staff, 'disputes', row.id, 'evidence-viewed', null, { chatId: requested, page })
      return { chats, chatId: requested, items, total: count.total, page, limit }
    })
  }

  private async deadlines(client: PoolClient) {
    if (!await this.settings.enabled('feature_disputes', client)) return { notified: 0, started: 0, reminded: 0 }
    const { rows: due } = await client.query<Case>(`
      SELECT *,number::text AS number FROM disputes
      WHERE (status='OPENED' AND notify_by<=now()) OR (status='AWAITING_MATERIALS' AND materials_by<=now())
      ORDER BY opened_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
    `)
    const result = { notified: 0, started: 0, reminded: 0 }
    for (const row of due) {
      if (row.status === 'OPENED') {
        await this.notifyParty(client, row)
        result.notified++
      } else {
        await this.beginReview(client, row)
        result.started++
      }
    }
    const clock = await this.jobs.clock(client)
    const oneDay = await workDeadline(client, clock.now, 1, clock.timezone)
    const { rows: reminders } = await client.query<Case>(`
      SELECT *,number::text AS number FROM disputes
      WHERE status='AWAITING_MATERIALS' AND materials_by>now() AND materials_by<=$1
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id=opened_by AND n.dedupe_key='dispute.reminder:' || disputes.id)
      ORDER BY materials_by,id LIMIT 100 FOR UPDATE SKIP LOCKED
    `, [oneDay])
    for (const row of reminders) {
      for (const target of [row.opened_by, row.against]) {
        await this.notice(client, row, target, 'reminder', 'Истекает срок подачи материалов по спору №' + row.number,
          'Передайте материалы до ' + dateLabel(row.materials_by!, clock.timezone) + '.')
      }
      result.reminded++
    }
    const { rows: conflicts } = await client.query<{ id: string; number: string }>(`
      SELECT d.id,d.number::text FROM disputes d JOIN users a ON a.id=d.opened_by JOIN users b ON b.id=d.against
      WHERE d.status IN ('REVIEW','REOPENED') AND NOT EXISTS (
        SELECT 1 FROM users u WHERE u.role IN ('ADMIN','MODERATOR') AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL AND NOT u.must_change_password
          AND (u.link_group IS NULL OR (u.link_group IS DISTINCT FROM a.link_group AND u.link_group IS DISTINCT FROM b.link_group))
      ) ORDER BY d.opened_at,d.id LIMIT 100
    `)
    for (const row of conflicts) await this.notifications.notifyStaff(client, {
      kind: 'dispute.conflict', title: 'Нужен сотрудник без конфликта интересов',
      body: 'В споре №' + row.number + ' все доступные сотрудники связаны со сторонами.',
      actions: [{ label: 'Открыть спор', href: adminHref(row.id) }], dedupeKey: 'dispute.conflict:' + row.id,
    })
    return result
  }

  private async event(client: PoolClient, row: Case, actor: string | null, text: string) {
    await client.query(`
      INSERT INTO disclosure_events(disclosure_id,actor_user_id,type,data)
      VALUES($1,$2,'DISPUTE',jsonb_build_object('text',$3::text,'disputeId',$4::text))
    `, [row.disclosure_id, actor, text, row.id])
  }

  private async notice(client: PoolClient, row: Case, recipient: string, kind: string, title: string, body: string, suffix?: string) {
    return this.notifications.notify(client, recipient, {
      kind: 'dispute.' + kind, title, body, channels: kind === 'materials' ? ['EMAIL', 'TELEGRAM'] : ['EMAIL'],
      actions: [{ label: 'Открыть спор', href: href(row.id) }], dedupeKey: ['dispute.' + kind, row.id, suffix].filter(Boolean).join(':'),
    })
  }
}
