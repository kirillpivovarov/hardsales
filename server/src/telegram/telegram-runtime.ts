import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { appOrigin, demoMode } from '../config';
import { DatabaseService } from '../database/database.service';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { allowedUpdates, TelegramApi, TelegramApiError, type TelegramPerson, type TelegramUpdate } from './telegram-api';
import { telegramMode, telegramToken } from './telegram-config';
import { skipTelegramDeliveries } from './telegram-sender';
import { TelegramUpdates } from './telegram-updates';

type WebhookInfo = { url?: string; pending_update_count?: number; last_error_message?: string; last_error_date?: number };

function safeRemoteError(value: unknown) {
  if (typeof value !== 'string') return null;
  const secrets = [telegramToken(), process.env.TELEGRAM_WEBHOOK_SECRET];
  let message = value;
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[скрыто]');
  return message.replace(/https?:\/\/\S+/gi, '[адрес]').slice(0, 200);
}

@Injectable()
export class TelegramRuntime implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramRuntime.name);
  private readonly stop = new AbortController();
  private active?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private connected = false;
  private retryAt = 0;

  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly notifications: ExchangeNotifications, private readonly api: TelegramApi, private readonly updates: TelegramUpdates) {}

  onModuleInit() {
    this.settings.onChange('feature_telegram', async (client, before, after) => {
      if (after !== true) {
        await skipTelegramDeliveries(client);
        return;
      }
      if (before === true || !telegramToken()) return;
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM users
        WHERE status='ACTIVE' AND email_verified_at IS NOT NULL AND role IN ('BUYER','SELLER') ORDER BY id`);
      for (const user of rows) await this.notifications.notify(client, user.id, {
        kind: 'telegram.announced', title: 'Подключите Telegram',
        body: 'Вопрос «Актуально?» можно подтвердить одной кнопкой в Telegram. Подключите бота в профиле.',
        actions: [{ label: 'Подключить', href: '/account' }], channels: ['EMAIL'], dedupeKey: 'telegram.announced:v1',
      });
    });
  }

  onApplicationBootstrap() {
    if (!telegramToken()) return;
    const tick = () => {
      if (this.active || this.stop.signal.aborted || Date.now() < this.retryAt) return;
      this.active = this.run().catch(() => this.logger.warn('Не удалось проверить Telegram'))
        .finally(() => { this.active = undefined; });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }

  async onModuleDestroy() {
    this.stop.abort();
    clearInterval(this.timer);
    await this.active;
  }

  private async run() {
    if (!await this.settings.enabled('feature_telegram')) {
      this.connected = false;
      return;
    }
    const mode = telegramMode();
    if (mode === 'webhook' && this.connected) return;
    try {
      await this.db.withSessionLock(21, async client => {
        await this.connect(client, mode);
        if (mode === 'polling') {
          try { await this.poll(client); }
          finally { this.connected = false; }
        }
      });
    } catch (error) {
      if (this.stop.signal.aborted) return;
      this.connected = false;
      this.retryAt = Date.now() + (error instanceof TelegramApiError && error.status === 429 ? Math.max(1, error.retryAfter) * 1000 : 5000);
      const message = error instanceof TelegramApiError ? error.message : 'Не удалось подключить Telegram';
      await this.db.query('UPDATE telegram_state SET last_error=$1,last_error_at=now()', [message]);
    }
  }

  private async connect(client: PoolClient, mode: 'webhook' | 'polling') {
    const identity = await this.api.call<TelegramPerson>('getMe', {}, this.stop.signal);
    if (!identity?.is_bot || !/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(identity?.username ?? '')) throw new TelegramApiError(0);
    if (mode === 'webhook') {
      await this.api.call('setWebhook', {
        url: this.webhookUrl(), secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: allowedUpdates,
      }, this.stop.signal);
    } else await this.api.call('deleteWebhook', {}, this.stop.signal);
    await client.query(`UPDATE telegram_state SET bot_username=$1,last_error=NULL,last_error_at=NULL,
      webhook_set_at=CASE WHEN $2='webhook' THEN now() END`, [identity.username, mode]);
    this.connected = true;
  }

  private webhookUrl() { return `${appOrigin()}/api/v1/telegram/webhook`; }

  private async poll(client: PoolClient) {
    const { rows: [state] } = await client.query<{ offset: string }>('SELECT polling_offset AS offset FROM telegram_state');
    let offset = Number(state.offset);
    while (!this.stop.signal.aborted && await this.settings.enabled('feature_telegram', client)) {
      const updates = await this.api.call<TelegramUpdate[]>('getUpdates', {
        offset, timeout: 25, allowed_updates: allowedUpdates,
      }, this.stop.signal);
      if (!Array.isArray(updates)) throw new TelegramApiError(0);
      for (const update of updates) {
        if (this.stop.signal.aborted) return;
        await this.updates.receive(update);
        offset = Math.max(offset, update.update_id + 1);
      }
      if (updates.length) await client.query('UPDATE telegram_state SET polling_offset=$1', [offset]);
    }
  }

  async status() {
    const mode = telegramMode();
    const tokenConfigured = Boolean(telegramToken());
    const enabled = await this.settings.enabled('feature_telegram');
    const [{ rows: [state] }, { rows: [links] }, { rows: [deliveries] }] = await Promise.all([
      this.db.query<{ botUsername: string | null; lastError: string | null; lastErrorAt: Date | null }>(`SELECT bot_username AS "botUsername",
        last_error AS "lastError",last_error_at AS "lastErrorAt" FROM telegram_state`),
      this.db.query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE telegram_chat_id IS NOT NULL'),
      this.db.query<Record<'SENT' | 'FAILED' | 'SKIPPED' | 'PENDING', number>>(`SELECT
        count(*) FILTER (WHERE d.status='SENT')::int AS "SENT",count(*) FILTER (WHERE d.status='FAILED')::int AS "FAILED",
        count(*) FILTER (WHERE d.status='SKIPPED')::int AS "SKIPPED",count(*) FILTER (WHERE d.status='PENDING')::int AS "PENDING"
        FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE d.channel='TELEGRAM' AND n.created_at >= now()-interval '24 hours'`),
    ]);
    let webhook: { url: string | null; pendingUpdateCount: number; lastErrorMessage: string | null; lastErrorDate: number | null } | null = null;
    if (mode === 'webhook' && tokenConfigured && enabled) {
      const info = await this.api.call<WebhookInfo>('getWebhookInfo').catch(() => null);
      if (info) webhook = { url: info.url === this.webhookUrl() ? info.url : null, pendingUpdateCount: Number(info.pending_update_count ?? 0),
        lastErrorMessage: safeRemoteError(info.last_error_message), lastErrorDate: info.last_error_date ?? null };
    }
    return { enabled, tokenConfigured, mode, ...state, webhook, linkedUsers: links.count, deliveries24h: deliveries, demoMode: demoMode() };
  }
}
