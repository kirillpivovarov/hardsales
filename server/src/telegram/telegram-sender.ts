import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService, type Queryable } from '../database/database.service';
import { RETRY_MINUTES } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { TelegramApi, TelegramApiError, type TelegramMessage } from './telegram-api';
import { noticeContent, type TelegramNotice } from './telegram-buttons';
import { telegramToken } from './telegram-config';
import { releaseTelegramFallbacks, TelegramLinks } from './telegram-links';

type Delivery = {
  id: string; attempts: number; userId: string; status: string;
  chatId: string | null; notice: TelegramNotice; late: boolean; nextChatSend: Date | null;
};

export async function skipTelegramDeliveries(client: Queryable): Promise<void> {
  const { rows } = await client.query<{ id: string }>(`UPDATE notification_deliveries SET status='SKIPPED'
    WHERE channel='TELEGRAM' AND status='PENDING' RETURNING id`);
  await releaseTelegramFallbacks(client, rows.map(row => row.id), false);
}

@Injectable()
export class TelegramSender implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramSender.name);
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly api: TelegramApi, private readonly links: TelegramLinks) {}

  onApplicationBootstrap() {
    if (!telegramToken()) {
      this.active = this.db.transaction(skipTelegramDeliveries).catch(() => this.logger.warn('Не удалось пересчитать резервные доставки Telegram'));
      return;
    }
    const tick = () => {
      if (this.active || this.abort.signal.aborted) return;
      this.active = this.sendBatch().catch(() => this.logger.warn('Не удалось обработать очередь Telegram'))
        .finally(() => { this.active = undefined; });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }

  async onModuleDestroy() {
    this.abort.abort();
    clearInterval(this.timer);
    await this.active;
  }

  private async sendBatch() {
    if (!await this.settings.enabled('feature_telegram')) return;
    await this.db.withSessionLock(20, async () => {
      // A chat at its own limit must not prevent other recipients from being served.
      for (let examined = 0; examined < 100 && !this.abort.signal.aborted; examined++) {
        if (!await this.db.transaction(client => this.sendOne(client))) break;
      }
    });
  }

  private async sendOne(client: PoolClient) {
    if (!await this.settings.enabled('feature_telegram', client)) return false;
    const { rows: [state] } = await client.query<{ paused: boolean }>(
      'SELECT coalesce(send_retry_at > clock_timestamp(),false) AS paused FROM telegram_state',
    );
    if (state.paused) return false;
    await client.query("DELETE FROM telegram_delivery_rate_window WHERE sent_at <= clock_timestamp()-interval '1 second'");
    const { rows: [rate] } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM telegram_delivery_rate_window');
    if (rate.count >= 25) return false;
    // Bind/unbind and send all lock the user before touching that user's delivery rows.
    const { rows: [candidate] } = await client.query<{ id: string }>(`SELECT d.id
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
      WHERE d.channel='TELEGRAM' AND d.status='PENDING' AND d.next_attempt_at<=now()
      ORDER BY d.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`);
    if (!candidate) return false;
    const { rows: [delivery] } = await client.query<Delivery>(`SELECT d.id,d.attempts,u.id AS "userId",u.status,
      u.telegram_chat_id AS "chatId", jsonb_build_object('id',n.id::text,'kind',n.kind,'title',n.title,'body',n.body,
        'actions',n.actions,'payload',n.payload) AS notice,
      CASE WHEN r.sent_at+interval '1.1 seconds' > clock_timestamp() THEN r.sent_at+interval '1.1 seconds' END AS "nextChatSend",
      (n.kind='actuality.ask' AND NOT (n.payload @> '{"manual":true}'::jsonb) AND (
        (clock_timestamp() AT TIME ZONE (z.value #>> '{}'))::time >= time '22:00' OR
        (clock_timestamp() AT TIME ZONE (z.value #>> '{}'))::date > (n.created_at AT TIME ZONE (z.value #>> '{}'))::date
      )) AS late
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
      JOIN platform_settings z ON z.key='timezone' LEFT JOIN telegram_delivery_recipient_limits r ON r.chat_id=u.telegram_chat_id
      WHERE d.id=$1 AND d.status='PENDING' FOR UPDATE OF d SKIP LOCKED`, [candidate.id]);
    if (!delivery) return true;
    if (!delivery.chatId || delivery.status !== 'ACTIVE' || delivery.late) {
      await this.finish(client, delivery.id, 'SKIPPED');
      return true;
    }
    if (delivery.nextChatSend) {
      await client.query('UPDATE notification_deliveries SET next_attempt_at=$2 WHERE id=$1', [delivery.id, delivery.nextChatSend]);
      return true;
    }
    await client.query('INSERT INTO telegram_delivery_rate_window VALUES (clock_timestamp())');
    await client.query(`INSERT INTO telegram_delivery_recipient_limits(chat_id,sent_at) VALUES ($1,clock_timestamp())
      ON CONFLICT(chat_id) DO UPDATE SET sent_at=excluded.sent_at`, [delivery.chatId]);
    let message: TelegramMessage;
    try {
      message = await this.api.call<TelegramMessage>('sendMessage', {
        chat_id: delivery.chatId, ...noticeContent(delivery.notice), link_preview_options: { is_disabled: true },
      }, this.abort.signal);
      if (!Number.isSafeInteger(message?.message_id)) throw new TelegramApiError(0);
    } catch (cause) {
      if (this.abort.signal.aborted) throw cause;
      const error = cause instanceof TelegramApiError ? cause : new TelegramApiError(0);
      return this.failed(client, delivery, error);
    }
    await client.query(`UPDATE notification_deliveries SET status='SENT',attempts=least(attempts+1,5),
      sent_at=now(),telegram_message_id=$2,error=NULL WHERE id=$1`, [delivery.id, message.message_id]);
    await releaseTelegramFallbacks(client, [delivery.id], true);
    return true;
  }

  private async failed(client: PoolClient, delivery: Delivery, error: TelegramApiError) {
    if (error.status === 429) {
      const delay = error.retryAfter || 1;
      await client.query(`UPDATE telegram_state SET send_retry_at=clock_timestamp()+$1::int*interval '1 second'`, [delay]);
      await client.query(`UPDATE notification_deliveries SET next_attempt_at=clock_timestamp()+$2::int*interval '1 second',
        error=$3 WHERE id=$1`, [delivery.id, delay, error.message]);
      return false;
    }
    if (error.status === 403 || (error.status === 400 && error.chatNotFound)) {
      await this.finish(client, delivery.id, 'FAILED', error.message);
      await this.links.disable(client, delivery.userId, error.chatNotFound ? 'CHAT_NOT_FOUND' : 'BOT_BLOCKED', delivery.chatId!);
      return true;
    }
    const delay = RETRY_MINUTES[delivery.attempts];
    const retryable = error.status === 0 || error.status >= 500;
    if (retryable && delay !== undefined) {
      await client.query(`UPDATE notification_deliveries SET attempts=attempts+1,
        next_attempt_at=clock_timestamp()+$2::int*interval '1 minute',error=$3 WHERE id=$1`, [delivery.id, delay, error.message]);
    } else await this.finish(client, delivery.id, 'FAILED', error.message);
    return true;
  }

  private async finish(client: PoolClient, id: string, status: 'FAILED' | 'SKIPPED', error: string | null = null) {
    await client.query(`UPDATE notification_deliveries
      SET status=$2,error=$3,attempts=least(attempts+CASE WHEN $2='FAILED' THEN 1 ELSE 0 END,5) WHERE id=$1`, [id, status, error]);
    await releaseTelegramFallbacks(client, [id], false);
  }
}
