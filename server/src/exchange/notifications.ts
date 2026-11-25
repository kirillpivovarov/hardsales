import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { MailService } from '../auth/mail.service';
import { appOrigin, port } from '../config';
import { DatabaseService, type Queryable } from '../database/database.service';
import { boolean, integer, pageParams } from '../market/market.inputs';
import { ExchangeJobs } from './jobs';

type DeliveryChannel = 'EMAIL' | 'TELEGRAM';
type NotificationAction = { label: string; token?: string; href?: string; action?: string };
type Notification = {
  kind: string; title: string; body: string; payload?: Record<string, unknown>;
  actions?: NotificationAction[]; dedupeKey?: string; channels?: DeliveryChannel[];
};
type Delivery = {
  id: string; channel: DeliveryChannel; attempts: number; userId: string; email: string; notifyEmail: boolean;
  status: string; title: string; body: string; actions: NotificationAction[];
};
const RETRY_MINUTES = [1, 5, 15, 60];

@Injectable()
export class ExchangeNotifications implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly jobs: ExchangeJobs, private readonly mail: MailService) {}

  onModuleInit(): void {
    this.jobs.register({ name: 'notifications.deliver', lock: 17, run: async (client, clock) => {
      await this.deliverNotifications(client, clock.timezone);
      await this.deliverExternal(client);
    } });
  }

  async notify(client: Queryable, userId: string, input: Notification): Promise<string | null> {
    const { rows: [notification] } = await client.query<{ id: string }>(`
      INSERT INTO notifications(user_id,kind,title,body,payload,actions,dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id,dedupe_key) DO NOTHING RETURNING id
    `, [userId, input.kind, input.title, input.body, JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.actions ?? []), input.dedupeKey ?? null]);
    if (!notification) return null;
    if (input.channels?.length) {
      await client.query(`
        INSERT INTO notification_deliveries(notification_id,channel)
        SELECT $1, channel FROM unnest($2::text[]) channel ON CONFLICT DO NOTHING
      `, [notification.id, input.channels]);
    }
    return notification.id;
  }

  async queueEmail(client: Queryable, input: { to: string; subject: string; body: string; dedupeKey?: string }): Promise<string | null> {
    const { rows: [row] } = await client.query<{ id: string }>(`
      INSERT INTO exchange_email_outbox(recipient,subject,body,dedupe_key) VALUES ($1,$2,$3,$4)
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id
    `, [input.to, input.subject, input.body, input.dedupeKey ?? null]);
    return row?.id ?? null;
  }

  async list(userId: string, query: Record<string, unknown>) {
    const { page, limit, offset } = pageParams(query);
    const onlyUnread = query.unread === undefined ? false : boolean(query.unread, 'Непрочитанные');
    const [items, counts] = await Promise.all([
      this.db.query(`
        SELECT id,kind,title,body,payload,actions,created_at AS "createdAt",read_at AS "readAt"
        FROM notifications WHERE user_id=$1 AND (NOT $2 OR read_at IS NULL) ORDER BY id DESC LIMIT $3 OFFSET $4
      `, [userId, onlyUnread, limit, offset]),
      this.db.query<{ total: number; unread: number }>(`
        SELECT count(*) FILTER (WHERE NOT $2 OR read_at IS NULL)::int AS total,
          count(*) FILTER (WHERE read_at IS NULL)::int AS unread FROM notifications WHERE user_id=$1
      `, [userId, onlyUnread]),
    ]);
    return { ...counts.rows[0], items: items.rows, page, limit };
  }

  async mark(userId: string, requestedId?: string) {
    const id = requestedId === undefined ? null : integer(requestedId, 'Уведомление', 1, Number.MAX_SAFE_INTEGER);
    const result = await this.db.query(`
      UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND ($2::bigint IS NULL OR id=$2)
    `, [userId, id]);
    if (id !== null && !result.rowCount) throw new NotFoundException('Уведомление не найдено');
    return { updated: result.rowCount ?? 0 };
  }

  private async deliverNotifications(client: PoolClient, timezone: string) {
    const { rows } = await client.query<Delivery>(`
      SELECT d.id,d.channel,d.attempts,u.id AS "userId",u.email,u.notify_email AS "notifyEmail",u.status,n.title,n.body,n.actions
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
      WHERE d.status='PENDING' AND d.next_attempt_at <= now() ORDER BY d.id LIMIT 20 FOR UPDATE OF d SKIP LOCKED
    `);
    for (const row of rows) {
      const { rows: [quota] } = await client.query<{ sent: number }>(`
        SELECT count(*)::int AS sent FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE n.user_id=$1 AND channel='EMAIL' AND d.status='SENT'
          AND (d.sent_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
      `, [row.userId, timezone]);
      if (row.channel !== 'EMAIL' || !row.notifyEmail || row.status !== 'ACTIVE' || quota.sent >= 30) {
        await client.query("UPDATE notification_deliveries SET status='SKIPPED' WHERE id=$1", [row.id]);
        continue;
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
    const { rows } = await client.query<{ id: string; recipient: string; subject: string; body: string; attempts: number }>(`
      SELECT id,recipient,subject,body,attempts FROM exchange_email_outbox
      WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED
    `);
    for (const row of rows) await this.send(client, 'exchange_email_outbox', row.id, row.attempts, row.recipient, row.subject, row.body);
  }

  private async send(client: PoolClient, table: 'exchange_email_outbox' | 'notification_deliveries', id: string,
    attempts: number, to: string, subject: string, text: string) {
    let status = 'SENT';
    try {
      await this.mail.sendMessage(to, subject, text);
    } catch {
      status = attempts < RETRY_MINUTES.length ? 'PENDING' : 'FAILED';
    }
    await client.query(`
      UPDATE ${table} SET status=$2, attempts=attempts+1,
        sent_at=CASE WHEN $2='SENT' THEN now() END, next_attempt_at=now()+$3::int*interval '1 minute'
      WHERE id=$1
    `, [id, status, RETRY_MINUTES[attempts] ?? 0]);
  }
}
