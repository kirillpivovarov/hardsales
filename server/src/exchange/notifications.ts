import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { MailService, mailErrorText } from '../auth/mail.service';
import { appOrigin, port } from '../config';
import { DatabaseService, type Queryable } from '../database/database.service';
import { boolean, integer, pageParams } from '../market/market.inputs';
import { telegramToken } from '../telegram/telegram-config';
import { ExchangeJobs } from './jobs';
import { applyChatRead, chatUnread, deliverChatDigest, deliverStaffPending, queueChatMessage,
  queueStaffNotice, staffDailyDigest } from './notification-queues';

type DeliveryChannel = 'EMAIL' | 'TELEGRAM';
export type NotificationAction = { label: string; token?: string; href?: string; action?: string; telegramLabel?: string };
export type Notification = {
  kind: string; title: string; body: string; payload?: Record<string, unknown>;
  actions?: NotificationAction[]; dedupeKey?: string; channels?: DeliveryChannel[];
  priority?: 1 | 2 | 3; deliveryOnly?: boolean;
};
type Delivery = {
  id: string; channel: DeliveryChannel; attempts: number; userId: string; email: string; notifyEmail: boolean;
  status: string; title: string; body: string; actions: NotificationAction[]; kind: string;
  infoEmailConsent: boolean; fallbackStatus: string | null; role: string; priority: number; chatId: string | null;
};
export const RETRY_MINUTES = [1, 5, 15, 60];
export const TELEGRAM_KINDS = new Set([
  'actuality.ask', 'actuality.remind', 'actuality.hidden', 'actuality.suspended', 'actuality.announced', 'actuality.bot_status',
  'match.new', 'disclosure.request', 'disclosure.first', 'disclosure.already_known', 'representation.request',
  'representation.answered', 'deal.followup', 'deal.agreed', 'listing.owner_confirm',
]);

const urgentKinds = new Set(['actuality.ask', 'actuality.remind', 'disclosure.request', 'disclosure.first', 'chat.message']);
const bulkKinds = new Set(['actuality.hidden', 'actuality.archived', 'staff.digest']);

@Injectable()
export class ExchangeNotifications implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly jobs: ExchangeJobs, private readonly mail: MailService) {}

  onModuleInit(): void {
    this.jobs.register({ name: 'notifications.deliver', lock: 17, run: async (client, clock) => {
      await this.deliverNotifications(client, clock.timezone);
      await this.deliverExternal(client);
    } });
    this.jobs.register({ name: 'chat.digest', lock: 24, run: async client => {
      await deliverChatDigest(client, this.enqueue);
      await deliverStaffPending(client, this.enqueue);
    } });
    this.jobs.register({ name: 'staff.digest', lock: 24, slot: clock => clock.day, enabled: async () => {
      const clock = await this.jobs.clock();
      const { rows: [setting] } = await this.db.query<{ value: number }>(
        "SELECT value FROM platform_settings WHERE key='staff_digest_hour'",
      );
      return clock.hour >= setting.value;
    }, run: (client, clock) => staffDailyDigest(client, this.enqueue, clock) });
  }

  private readonly enqueue = (client: Queryable, userId: string, notice: Notification) => this.notify(client, userId, notice);

  notifyStaff(client: Queryable, notice: Notification) {
    return queueStaffNotice(client, this.enqueue, notice);
  }

  chatMessage(client: Queryable, chat: string, receiver: string, sender: string, message: number) {
    return queueChatMessage(client, this.enqueue, chat, receiver, sender, message, Boolean(telegramToken()));
  }

  chatRead(client: Queryable, chat: string, receiver: string, readThrough: string) {
    return applyChatRead(client, chat, receiver, readThrough);
  }

  async counts(userId: string, participant: boolean) {
    const chat = participant ? '(' + chatUnread + ')' : '0';
    const { rows: [counts] } = await this.db.query<{ unread: number; chats: number }>(`
      SELECT (SELECT count(*)::int FROM notifications WHERE user_id=$1 AND read_at IS NULL AND NOT delivery_only) AS unread,
        ${chat} AS chats
    `, [userId]);
    return counts;
  }

  async notify(client: Queryable, userId: string, input: Notification): Promise<string | null> {
    const priority = input.priority ?? (urgentKinds.has(input.kind) ? 1 : bulkKinds.has(input.kind) ? 3 : 2);
    const { rows: [notification] } = await client.query<{ id: string }>(`
      INSERT INTO notifications(user_id,kind,title,body,payload,actions,dedupe_key,priority,delivery_only)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (user_id,dedupe_key) DO NOTHING RETURNING id
    `, [userId, input.kind, input.title, input.body, JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.actions ?? []), input.dedupeKey ?? null, priority, input.deliveryOnly ?? false]);
    if (!notification) return null;
    const email = input.channels?.includes('EMAIL') ?? false;
    const telegram = Boolean(telegramToken()) && (input.channels?.includes('TELEGRAM') || TELEGRAM_KINDS.has(input.kind)
      || input.kind.startsWith('verification.'));
    if (!email && !telegram) return notification.id;
    await client.query(`
      WITH eligible AS (
        SELECT $2 AND (NOT $4::boolean OR u.info_email_consent) AS email,
          $3 AND u.telegram_chat_id IS NOT NULL AND u.status='ACTIVE' AND u.role IN ('BUYER','SELLER') AND EXISTS (
            SELECT 1 FROM platform_settings WHERE key='feature_telegram' AND value='true'::jsonb
          ) AS telegram FROM users u WHERE u.id=$5
      ), created AS (
        INSERT INTO notification_deliveries(notification_id,channel)
        SELECT $1,'TELEGRAM' FROM eligible WHERE telegram RETURNING id
      )
      INSERT INTO notification_deliveries(notification_id,channel,next_attempt_at,fallback_for)
      SELECT $1,'EMAIL',now()+CASE WHEN c.id IS NULL THEN interval '0' ELSE interval '30 minutes' END,c.id
      FROM eligible e LEFT JOIN created c ON true WHERE e.email
    `, [notification.id, email, telegram, input.kind.startsWith('info.'), userId]);
    return notification.id;
  }

  async queueEmail(client: Queryable, input: {
    to: string; subject: string; body: string; dedupeKey?: string; respectsOptOut?: boolean;
  }): Promise<string | null> {
    const { rows: [row] } = await client.query<{ id: string }>(`
      INSERT INTO exchange_email_outbox(recipient,subject,body,dedupe_key,respects_opt_out) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id
    `, [input.to, input.subject, input.body, input.dedupeKey ?? null, input.respectsOptOut ?? false]);
    return row?.id ?? null;
  }

  async list(userId: string, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const onlyUnread = query.unread === undefined ? false : boolean(query.unread, 'Непрочитанные');
    const [items, counts] = await Promise.all([
      this.db.query(`
        SELECT id,kind,title,body,payload,actions,created_at AS "createdAt",read_at AS "readAt"
        FROM notifications WHERE user_id=$1 AND NOT delivery_only AND (NOT $2 OR read_at IS NULL) ORDER BY id DESC LIMIT $3 OFFSET $4
      `, [userId, onlyUnread, limit, offset]),
      this.db.query<{ total: number; unread: number }>(`
        SELECT count(*) FILTER (WHERE NOT $2 OR read_at IS NULL)::int AS total,
          count(*) FILTER (WHERE read_at IS NULL)::int AS unread FROM notifications WHERE user_id=$1 AND NOT delivery_only
      `, [userId, onlyUnread]),
    ]);
    return { ...counts.rows[0], items: items.rows, page, limit };
  }

  async mark(userId: string, requestedId?: string) {
    const id = requestedId === undefined ? null : integer(requestedId, 'Уведомление', 1, Number.MAX_SAFE_INTEGER);
    const result = await this.db.query(`
      UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND NOT delivery_only AND ($2::bigint IS NULL OR id=$2)
    `, [userId, id]);
    if (id !== null && !result.rowCount) throw new NotFoundException('Уведомление не найдено');
    return { updated: result.rowCount ?? 0 };
  }

  private async deliverNotifications(client: PoolClient, timezone: string) {
    const { rows } = await client.query<Delivery>(`
      SELECT d.id,d.channel,d.attempts,u.id AS "userId",u.email,u.notify_email AS "notifyEmail",u.status,n.title,n.body,n.actions,n.kind,
        u.info_email_consent AS "infoEmailConsent",t.status AS "fallbackStatus",u.role,n.priority,n.payload->>'chatId' AS "chatId"
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
      LEFT JOIN notification_deliveries t ON t.id=d.fallback_for
      WHERE d.channel='EMAIL' AND d.status='PENDING' AND d.next_attempt_at <= now()
      ORDER BY n.priority,d.id LIMIT 20 FOR UPDATE OF d SKIP LOCKED
    `);
    for (const row of rows) {
      const skip = row.fallbackStatus === 'SENT' ? 'Доставлено в Telegram'
        : row.status !== 'ACTIVE' ? 'Профиль недоступен'
        : !row.notifyEmail ? 'Участник отключил уведомления по почте'
        : row.kind.startsWith('info.') && !row.infoEmailConsent ? 'Нет согласия на информационные письма' : null;
      if (skip) {
        await client.query("UPDATE notification_deliveries SET status='SKIPPED',error=$2 WHERE id=$1", [row.id, skip]);
        continue;
      }
      if (row.kind === 'chat.message' && row.chatId) {
        const { rowCount: deferred } = await client.query(`
          UPDATE notification_deliveries SET next_attempt_at=(
            SELECT max(d.sent_at)+interval '15 minutes' FROM notification_deliveries d
              JOIN notifications n ON n.id=d.notification_id
            WHERE n.user_id=$2 AND n.kind='chat.message' AND n.payload->>'chatId'=$3
              AND d.channel='EMAIL' AND d.status='SENT'
          )
          WHERE id=$1 AND EXISTS (
            SELECT 1 FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
            WHERE n.user_id=$2 AND n.kind='chat.message' AND n.payload->>'chatId'=$3
              AND d.channel='EMAIL' AND d.status='SENT' AND d.sent_at>now()-interval '15 minutes')
        `, [row.id, row.userId, row.chatId]);
        if (deferred) continue;
      }
      if (row.role === 'BUYER' || row.role === 'SELLER') {
        const { rows: [quota] } = await client.query<{ sent: number }>(`
          SELECT count(*)::int AS sent FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
          WHERE n.user_id=$1 AND channel='EMAIL' AND d.status='SENT'
            AND (d.sent_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
        `, [row.userId, timezone]);
        if (row.priority === 3 && quota.sent >= 25) {
          await client.query(`
            UPDATE notification_deliveries SET next_attempt_at=((now() AT TIME ZONE $2)::date+1)::timestamp AT TIME ZONE $2
            WHERE id=$1
          `, [row.id, timezone]);
          continue;
        }
        if (quota.sent >= 30) {
          await client.query("UPDATE notification_deliveries SET status='SKIPPED',error='Дневной лимит уведомлений по почте' WHERE id=$1", [row.id]);
          continue;
        }
      }
      const origin = appOrigin() ?? 'http://localhost:' + port('PORT', 3001);
      const links = row.actions.flatMap(action => {
        const path = action.token ? '/a/' + encodeURIComponent(action.token) : action.href;
        return path && /^\/(?![\\/])/.test(path) ? [action.label + ': ' + new URL(path, origin).href] : [];
      });
      await this.send(client, 'notification_deliveries', row.id, row.attempts, row.email, row.title,
        [row.body, ...links].join('\n\n'));
    }
  }

  private async deliverExternal(client: PoolClient) {
    await client.query(`
      UPDATE exchange_email_outbox e SET status='SKIPPED',error='Получатель отказался от писем'
      WHERE e.status='PENDING' AND e.respects_opt_out AND EXISTS (
        SELECT 1 FROM email_suppressions s WHERE s.email_hash=encode(sha256(convert_to(lower(e.recipient),'UTF8')),'hex')
      )
    `);
    const { rows } = await client.query<{ id: string; recipient: string; subject: string; body: string; attempts: number }>(`
      SELECT id,recipient,subject,body,attempts FROM exchange_email_outbox
      WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED
    `);
    for (const row of rows) await this.send(client, 'exchange_email_outbox', row.id, row.attempts, row.recipient, row.subject, row.body);
  }

  private async send(client: PoolClient, table: 'exchange_email_outbox' | 'notification_deliveries', id: string,
    attempts: number, to: string, subject: string, text: string) {
    let status = 'SENT';
    let error: string | null = null;
    try {
      await this.mail.sendMessage(to, subject, text);
    } catch (cause) {
      status = attempts < RETRY_MINUTES.length ? 'PENDING' : 'FAILED';
      error = mailErrorText(cause);
    }
    await client.query(`
      UPDATE ${table} SET status=$2, attempts=attempts+1,last_attempt_at=now(),error=$4,
        sent_at=CASE WHEN $2='SENT' THEN now() END, next_attempt_at=now()+$3::int*interval '1 minute'
      WHERE id=$1
    `, [id, status, RETRY_MINUTES[attempts] ?? 0, error]);
  }
}
