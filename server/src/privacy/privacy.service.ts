import {
  BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException,
  type OnApplicationBootstrap, type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth/auth.crypto';
import type { ParticipantRole, SessionUser, StaffSession } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { DisclosuresService } from '../exchange/disclosures.service';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { object, oneOf, pageParams, str, uuid } from '../market/market.inputs';

type Participant = SessionUser<ParticipantRole>;
type Administrator = StaffSession<'ADMIN'>;
const kinds = ['EXPORT', 'DELETE'] as const;
const statuses = ['NEW', 'DONE', 'REJECTED'] as const;
type Kind = typeof kinds[number];
type Status = typeof statuses[number];
type RequestRow = { id: string; number: string; user_id: string; kind: Kind; status: Status };
type Target = { id: string; email: string; status: string; deleted_at: Date | null; telegram_chat_id: string | null };
const archiveJson = promisify(gzip);
const maxArchiveSize = 20 * 1024 * 1024;
const requestFields = `
  d.id,d.number,d.kind,d.status,d.requested_at AS "requestedAt",d.handled_at AS "handledAt",
  d.export_expires_at AS "exportExpiresAt",
  COALESCE(d.export_expires_at>now() AND d.export_content IS NOT NULL,false) AS "exportAvailable"
`;

@Injectable()
export class PrivacyService implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications,
    private readonly disclosures: DisclosuresService,
  ) {}

  onModuleInit() {
    this.settings.onChange('pd_policy_version', async (client, before, after) => {
      if (before === after) return;
      await client.query(`
        INSERT INTO notifications(user_id,kind,title,body,actions)
        SELECT id,'privacy.policy_updated','Политика обработки персональных данных обновилась',
               'Примите её при следующем входе.',
               '[{"label":"Открыть политику","href":"/info/pd_policy"}]'::jsonb
        FROM users WHERE status='ACTIVE' AND role IN ('BUYER','SELLER')
      `);
    });
    this.settings.onChange('third_party_letter', async (client, _before, after) => {
      if ((after as { approved?: boolean })?.approved === true) return;
      // Delivery updates lock the outbox first and the letter second via its trigger.
      const { rows } = await client.query<{ id: string }>(`
        UPDATE exchange_email_outbox SET status='SKIPPED' WHERE respects_opt_out AND status='PENDING' RETURNING id
      `);
      await client.query(`
        UPDATE company_email_letters SET status='EXPIRED' WHERE outbox_id=ANY($1::bigint[]) AND status='SENT'
      `, [rows.map(row => row.id)]);
    });
  }

  async onApplicationBootstrap() {
    await this.db.query(`
      INSERT INTO notifications(user_id,kind,title,body,actions,dedupe_key)
      SELECT u.id,'privacy.letter_approval','Текст письма компаниям ждёт утверждения',
        'Письма компаниям доступны после утверждения текста владельцем площадки.',
        '[{"label":"Открыть настройки","href":"/admin?section=exchange&part=settings"}]'::jsonb,
        'privacy.letter_approval'
      FROM users u, platform_settings s WHERE u.role='ADMIN' AND u.status='ACTIVE'
        AND s.key='third_party_letter' AND s.value->>'approved'='false'
      ON CONFLICT(user_id,dedupe_key) DO NOTHING
    `);
  }

  async own(user: Participant) {
    const { rows } = await this.db.query(`
      SELECT ${requestFields}, CASE WHEN d.status='REJECTED' THEN handler_note END AS "rejectionReason"
      FROM data_requests d WHERE d.user_id=$1 ORDER BY d.number DESC
    `, [user.id]);
    return { items: rows };
  }

  async create(user: Participant, raw: unknown) {
    const input = object(raw);
    const kind = oneOf(input.kind, kinds, 'Действие с данными');
    const comment = input.comment === undefined ? null : str(input.comment, 'Комментарий', 0, 1000) || null;
    return this.db.transaction(async client => {
      await this.lockTarget(client, user.id, true);
      const { rows: [created] } = await client.query<RequestRow>(`
        INSERT INTO data_requests (user_id,kind,comment) VALUES ($1,$2,$3)
        ON CONFLICT (user_id,kind) WHERE status='NEW' DO NOTHING RETURNING id,number,user_id,kind,status
      `, [user.id, kind, comment]);
      if (!created) throw new ConflictException('Запрос уже принят');
      const { rows: [admin] } = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE role='ADMIN' AND status='ACTIVE'",
      );
      if (admin) await this.notifications.notify(client, admin.id, {
        kind: 'privacy.requested', title: 'Новый запрос по персональным данным',
        body: (kind === 'EXPORT' ? 'Выгрузка' : 'Удаление') + ' · ' + user.displayName,
        payload: { userId: user.id, requestId: created.id },
        actions: [{ label: 'Открыть запросы', href: '/admin?section=exchange&part=data-requests' }],
      });
      await auditExchange(client, user, 'data_requests', created.id, 'requested', null, { kind });
      return this.view(client, created.id);
    });
  }

  async list(query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const status = query.status ? oneOf(query.status, statuses, 'Статус') : null;
    const [{ rows }, { rows: [count] }] = await Promise.all([
      this.db.query(`
        SELECT ${requestFields},d.user_id AS "userId",u.display_name AS "nickname",
               d.comment,d.handler_note AS "handlerNote"
        FROM data_requests d JOIN users u ON u.id=d.user_id
        WHERE ($1::text IS NULL OR d.status=$1)
        ORDER BY d.number DESC LIMIT $2 OFFSET $3
      `, [status, limit, offset]),
      this.db.query<{ total: number }>('SELECT count(*)::int AS total FROM data_requests WHERE ($1::text IS NULL OR status=$1)', [status]),
    ]);
    return { items: rows, ...count, page, limit };
  }

  async consents(input: string) {
    const id = uuid(input);
    const { rows } = await this.db.query(`
      SELECT id,kind,granted,policy_version AS "policyVersion",given_at AS "givenAt",
        host(ip) AS ip,user_agent AS "userAgent",source
      FROM user_consents WHERE user_id=$1 ORDER BY id DESC
    `, [id]);
    return { items: rows };
  }

  async suppressionCount() {
    const { rows: [result] } = await this.db.query<{ count: number }>('SELECT count(*)::int AS count FROM email_suppressions');
    return result;
  }

  async build(actor: Administrator, input: string) {
    return this.db.transaction(async client => {
      const request = await this.lockRequest(client, actor, input, 'EXPORT');
      const [data, messages] = await this.exportData(client, request.user_id);
      let file = await this.pack(data, messages, request.number, false);
      if (file.length > maxArchiveSize) {
        const recent = await this.exportMessages(client, request.user_id, true);
        file = await this.pack(data, recent, request.number, true);
      }
      if (file.length > maxArchiveSize) throw new ConflictException('Объём данных больше 20 МиБ. Обработайте запрос вручную.');
      await client.query(`
        UPDATE data_requests SET status='DONE',handled_by=$2,handled_at=now(),export_content=$3,
          export_expires_at=now()+interval '7 days' WHERE id=$1
      `, [request.id, actor.id, file]);
      await this.notifications.notify(client, request.user_id, {
        kind: 'privacy.export_built', title: 'Выгрузка ваших данных готова',
        body: 'Скачать можно в профиле в течение 7 дней.', channels: ['EMAIL'],
        actions: [{ label: 'Открыть профиль', href: '/account#personal-data' }],
      });
      await auditExchange(client, actor, 'data_requests', request.id, 'export_built');
      return this.view(client, request.id);
    });
  }

  async download(user: Participant, input: string) {
    const id = uuid(input);
    return this.db.transaction(async client => {
      await this.lockTarget(client, user.id, true);
      const { rows: [request] } = await client.query<{ number: string; export_content: Buffer | null; expired: boolean }>(`
        SELECT number,export_content,export_expires_at<=now() AS expired FROM data_requests
        WHERE id=$1 AND user_id=$2 AND status='DONE' AND kind='EXPORT' FOR SHARE
      `, [id, user.id]);
      if (!request) throw new NotFoundException('Выгрузка не найдена');
      if (request.expired) throw new GoneException('Срок хранения выгрузки истёк');
      if (!request.export_content) throw new NotFoundException('Выгрузка не найдена');
      await auditExchange(client, user, 'data_requests', id, 'export_downloaded');
      return { buffer: request.export_content, number: request.number };
    });
  }

  async reject(actor: Administrator, input: string, raw: unknown) {
    const note = str(object(raw).note, 'Причина отказа', 3, 1000);
    return this.db.transaction(async client => {
      const request = await this.lockRequest(client, actor, input);
      await client.query(`
        UPDATE data_requests SET status='REJECTED',handled_by=$2,handled_at=now(),handler_note=$3 WHERE id=$1
      `, [request.id, actor.id, note]);
      await this.notifications.notify(client, request.user_id, {
        kind: 'privacy.request_rejected', title: 'Запрос отклонён',
        body: `Запрос №${request.number} отклонён: ${note}`, channels: ['EMAIL'],
      });
      await auditExchange(client, actor, 'data_requests', request.id, 'rejected');
      return this.view(client, request.id);
    });
  }

  async erase(actor: Administrator, input: string, raw: unknown) {
    if (object(raw).confirm !== true) throw new BadRequestException('Подтвердите удаление данных');
    const erasedPassword = await hashPassword(randomBytes(32).toString('base64url'));
    return this.db.transaction(async client => {
      const request = await this.lockRequest(client, actor, input, 'DELETE');
      const target = await this.lockTarget(client, request.user_id);
      const retained = await this.eraseData(client, target, erasedPassword);
      await client.query(`
        UPDATE data_requests SET status='DONE',handled_by=$2,handled_at=now(),handler_note=$3 WHERE id=$1
      `, [request.id, actor.id, retained.join(' · ')]);
      await this.notifications.queueEmail(client, {
        to: target.email, subject: 'hwforai: удаление персональных данных',
        body: 'Данные вашего профиля удалены. Записи журнала раскрытий, сообщения в чатах собеседников и документы сделок сохранены согласно политике площадки.',
        dedupeKey: 'privacy.deleted:' + request.id,
      });
      await auditExchange(client, actor, 'data_requests', request.id, 'deleted', null, { retained });
      return { retained };
    });
  }

  private async lockTarget(client: PoolClient, userId: string, requireActive = false): Promise<Target> {
    const { rows: [target] } = await client.query<Target>(`
      SELECT id,email,status,deleted_at,telegram_chat_id FROM users WHERE id=$1 AND role IN ('BUYER','SELLER') FOR UPDATE
    `, [userId]);
    if (!target) throw new NotFoundException('Профиль участника не найден');
    if (target.deleted_at) throw new ConflictException('Данные уже удалены');
    if (requireActive && target.status !== 'ACTIVE') throw new ForbiddenException('Профиль недоступен');
    return target;
  }

  private async lockRequest(client: PoolClient, actor: Administrator, input: string, kind?: Kind): Promise<RequestRow> {
    await lockTrustStaff(client, actor);
    const id = uuid(input);
    const { rows: [owner] } = await client.query<{ user_id: string }>('SELECT user_id FROM data_requests WHERE id=$1', [id]);
    if (!owner) throw new NotFoundException('Запрос не найден');
    await this.lockTarget(client, owner.user_id);
    const { rows: [request] } = await client.query<RequestRow>('SELECT * FROM data_requests WHERE id=$1 FOR UPDATE', [id]);
    if (request.status !== 'NEW' || kind && request.kind !== kind) throw new ConflictException('Запрос уже обработан или недоступен');
    return request;
  }

  private async view(client: Queryable, id: string) {
    const { rows: [request] } = await client.query(`SELECT ${requestFields} FROM data_requests d WHERE d.id=$1`, [id]);
    return request;
  }

  private async exportMessages(client: Queryable, userId: string, recent = false) {
    const { rows } = await client.query(`
      SELECT id,chat_id,body,created_at FROM chat_messages
      WHERE sender_id=$1 AND (NOT $2 OR created_at>=now()-interval '12 months') ORDER BY id
    `, [userId, recent]);
    return rows;
  }

  private async exportData(client: PoolClient, userId: string) {
    const { rows: [data] } = await client.query<Record<string, unknown>>(`
      SELECT
        jsonb_build_object('id',u.id,'username',u.username,'displayName',u.display_name,'email',u.email,'role',u.role,
          'participantType',u.participant_type,'companyName',u.company_name,'country',u.country,'city',u.city,
          'telegram',u.telegram,'telegramUsername',u.telegram_username,'companyEmail',u.company_email,
          'verificationLevel',u.verification_level,'notifyEmail',u.notify_email,
          'infoEmailConsent',u.info_email_consent,'createdAt',u.created_at) AS profile,
        u.onboarding_answers AS onboarding,
        (SELECT COALESCE(jsonb_agg(to_jsonb(c)-'ip'-'user_agent' ORDER BY c.id),'[]')
          FROM user_consents c WHERE c.user_id=u.id) AS consents,
        (SELECT COALESCE(jsonb_agg(to_jsonb(p)-'confirmed_by'-'email_ack' ORDER BY p.number),'[]')
          FROM user_principals p WHERE p.user_id=u.id) AS principals,
        (SELECT COALESCE(jsonb_agg((to_jsonb(l)-'duplicate_of'-'lot_key') || jsonb_build_object('priceHistory',(
          SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]') FROM listing_price_history h WHERE h.listing_id=l.id))
          ORDER BY l.created_at),'[]') FROM listings l WHERE l.owner_id=u.id) AS listings,
        (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at),'[]') FROM reviews r WHERE r.author_id=u.id) AS reviews,
        (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at),'[]') FROM reports r WHERE r.reporter_id=u.id) AS reports,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('listingId',p.listing_id,'askedAt',p.asked_at,
          'answeredAt',p.answered_at,'principalLegalName',p.principal_legal_name,'note',p.note,
          'exclusiveMandate',p.exclusive_mandate) ORDER BY p.asked_at),'[]')
          FROM lot_principal_requests p WHERE p.agent_id=u.id) AS "principalRequests",
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('listingId',a.listing_id,'reason',a.reason,
          'createdAt',a.created_at,'resolvedAt',a.resolved_at) ORDER BY a.created_at),'[]')
          FROM lot_duplicate_appeals a WHERE a.owner_id=u.id) AS "duplicateAppeals",
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',d.id,'disclosureId',d.disclosure_id,'status',d.status,
          'sellListingId',d.sell_listing_id,'buyListingId',d.buy_listing_id,'createdAt',d.created_at,
          'myTerms',CASE WHEN d.seller_id=u.id THEN d.seller_agreed ELSE d.buyer_agreed END) ORDER BY d.created_at),'[]')
          FROM deals d WHERE u.id IN (d.seller_id,d.buyer_id)) AS deals,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',d.id,'fileName',d.file_name,'kind',d.kind,'status',d.status,
          'uploadedAt',d.uploaded_at) ORDER BY d.uploaded_at),'[]')
          FROM verification_documents d WHERE d.user_id=u.id) AS documents,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',n.kind,'title',n.title,'body',n.body,'createdAt',n.created_at,
          'readAt',n.read_at) ORDER BY n.id),'[]') FROM notifications n WHERE n.user_id=u.id) AS notifications
      FROM users u WHERE u.id=$1
    `, [userId]);
    return [{ ...data, disclosures: await this.disclosures.participantExport(client, userId) }, await this.exportMessages(client, userId)] as const;
  }

  private pack(data: Record<string, unknown>, messages: unknown[], number: string, truncated: boolean) {
    return archiveJson(JSON.stringify({
      ...data, messages, requestNumber: number, exportedAt: new Date().toISOString(), truncated,
      ...(truncated && { truncation: 'Из выгрузки исключены сообщения старше 12 месяцев.' }),
    }));
  }

  private async eraseData(client: PoolClient, target: Target, password: string) {
    const id = target.id;
    const suffix = id.replaceAll('-', '').slice(0, 8);
    const alternate = id.replaceAll('-', '').slice(0, 24);
    await client.query(`
      UPDATE users SET username=CASE WHEN EXISTS(SELECT 1 FROM users WHERE lower(username)='deleted-' || $2 AND id<>$1)
          THEN 'deleted-' || $3 ELSE 'deleted-' || $2 END,
        display_name='Удалённый участник',email='deleted+' || id || '@invalid.invalid',password_hash=$4,
        participant_type='INDIVIDUAL',company_name=NULL,city='-',country='ZZ',telegram='deleted_' || $2,
        status='BANNED',deleted_at=now(),updated_at=now(),credential_version=credential_version+1,notify_email=false,
        pd_consent_version=NULL,pd_consent_at=NULL,info_email_consent=false,
        telegram_chat_id=NULL,telegram_user_id=NULL,telegram_username=NULL,telegram_linked_at=NULL,
        telegram_disabled_at=NULL,telegram_disabled_reason=NULL,company_email=NULL,
        company_email_domain_kind=NULL,company_email_confirmed_at=NULL,onboarding_answers='{}'::jsonb,
        onboarding_submitted_at=NULL,agent_fee_principal_says=NULL,verification_note=NULL,publish_ban_note=NULL
      WHERE id=$1
    `, [id, suffix, alternate, password]);
    await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
    await client.query('DELETE FROM email_challenges WHERE user_id=$1 OR lower(email)=lower($2)', [id, target.email]);
    await client.query('DELETE FROM telegram_handle_history WHERE user_id=$1', [id]);
    await client.query('DELETE FROM telegram_dialogs WHERE user_id=$1', [id]);
    await client.query('DELETE FROM telegram_delivery_recipient_limits WHERE chat_id=$1', [target.telegram_chat_id]);
    await client.query('DELETE FROM contact_block_events WHERE user_id=$1', [id]);
    await client.query('UPDATE contact_block_events SET peer_id=NULL WHERE peer_id=$1', [id]);
    await client.query('DELETE FROM lot_principal_requests WHERE agent_id=$1', [id]);
    await client.query('DELETE FROM lot_duplicate_appeals WHERE owner_id=$1', [id]);
    await client.query(`
      DELETE FROM action_tokens WHERE user_id=$1 OR
        (purpose IN ('principal.confirm','company_email.confirm') AND subject_id IN (
          SELECT id::text FROM company_email_letters WHERE user_id=$1))
    `, [id]);
    await client.query(`
      DELETE FROM exchange_email_outbox WHERE lower(recipient)=lower($2)
        OR id IN (SELECT outbox_id FROM company_email_letters WHERE user_id=$1)
    `, [id, target.email]);
    await client.query('DELETE FROM company_email_letters WHERE user_id=$1', [id]);
    await client.query(`
      DELETE FROM notifications WHERE user_id=$1 OR (kind='privacy.requested' AND payload->>'userId'=$1::text)
    `, [id]);
    await client.query(`
      UPDATE moderation_audit SET actor='Удалённый участник'
      WHERE actor_user_id=$1 AND entity='data_requests'
    `, [id]);
    await client.query(`
      UPDATE listings SET status='ARCHIVED',archived_at=COALESCE(archived_at,now()),
        archived_reason=COALESCE(archived_reason,'OWNER'),updated_at=now(),image_key=NULL
      WHERE owner_id=$1
    `, [id]);
    await client.query('DELETE FROM listing_images WHERE listing_id IN (SELECT id FROM listings WHERE owner_id=$1)', [id]);
    await client.query(`
      UPDATE user_principals SET name='Удалённый принципал',company='',email=NULL,confirmed_by=NULL,email_ack=NULL,
        removed_at=COALESCE(removed_at,now()) WHERE user_id=$1
    `, [id]);
    await client.query(`
      UPDATE listings SET proof_document_id=NULL,proof_status='NONE',proof_verified_at=NULL
      WHERE proof_document_id IN (SELECT id FROM verification_documents WHERE user_id=$1 AND deal_id IS NULL)
    `, [id]);
    await client.query('DELETE FROM verification_documents WHERE user_id=$1 AND deal_id IS NULL', [id]);
    await client.query(`
      UPDATE data_requests SET comment=NULL,handler_note=NULL,export_content=NULL,
        export_expires_at=CASE WHEN export_expires_at IS NOT NULL THEN now() END,
        status=CASE WHEN kind='EXPORT' AND status='NEW' THEN 'REJECTED' ELSE status END
      WHERE user_id=$1
    `, [id]);
    const { rows: [counts] } = await client.query<{ disclosure: number; document: number; message: number; consent: number }>(`
      SELECT (SELECT count(*)::int FROM disclosures WHERE $1 IN (user_a_id,user_b_id)) AS disclosure,
        (SELECT count(*)::int FROM verification_documents WHERE user_id=$1 AND deal_id IS NOT NULL) AS document,
        (SELECT count(*)::int FROM chat_messages WHERE sender_id=$1) AS message,
        (SELECT count(*)::int FROM user_consents WHERE user_id=$1) AS consent
    `, [id]);
    return [`Раскрытия: ${counts.disclosure}`, `Документы сделок: ${counts.document}`,
      `Сообщения у собеседников: ${counts.message}`, `Записи о согласии: ${counts.consent}`];
  }
}
