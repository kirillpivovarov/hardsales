import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hashToken } from '../auth/auth.crypto';
import { TELEGRAM_PATTERN } from '../auth/auth.dto';
import type { StaffSession } from '../auth/auth.types';
import { DatabaseService, type Queryable } from '../database/database.service';
import { ExchangeActions } from '../exchange/actions';
import { auditExchange } from '../exchange/audit';
import { ExchangeNotifications } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { lockTrustStaff } from '../exchange/trust-access';
import { policyRequired, policyVersion } from '../privacy/policy';
import type { TelegramPerson } from './telegram-api';
import { telegramToken } from './telegram-config';

type DisableReason = 'USER_STOP' | 'PROFILE_UNLINK' | 'BOT_BLOCKED' | 'CHAT_NOT_FOUND' | 'ADMIN';
type LinkedMember = { id: string; status: string; chatId: string; name: string };
type Nicknames = { profileUsername: string | null; username: string | null; verified: boolean };
const oldLink = 'Ссылка устарела. Откройте профиль на сайте и нажмите «Подключить Telegram» ещё раз.';
const linkTaken = 'Этот Telegram уже привязан к другому аккаунту площадки. Отвяжите его там командой /stop.';

function observedUsername(from: TelegramPerson): string | null {
  return typeof from.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(from.username) ? from.username : null;
}

export async function releaseTelegramFallbacks(client: Queryable, deliveryIds: string[], sent: boolean): Promise<void> {
  if (!deliveryIds.length) return;
  if (sent) {
    await client.query(`UPDATE notification_deliveries SET status='SKIPPED'
      WHERE fallback_for=ANY($1::bigint[]) AND channel='EMAIL' AND status='PENDING'`, [deliveryIds]);
  } else {
    await client.query(`UPDATE notification_deliveries SET next_attempt_at=now()
      WHERE fallback_for=ANY($1::bigint[]) AND channel='EMAIL' AND status='PENDING'`, [deliveryIds]);
  }
}

@Injectable()
export class TelegramLinks {
  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly actions: ExchangeActions, private readonly notifications: ExchangeNotifications) {}

  async state(userId: string) {
    const { rows: [state] } = await this.db.query<Nicknames & {
      linked: boolean; linkedAt: Date | null; disabledReason: DisableReason | null;
      botUsername: string | null; feature: boolean;
    }>(`SELECT u.telegram_chat_id IS NOT NULL AS linked, u.telegram_username AS username,
      u.telegram AS "profileUsername", telegram_handle_verified(u) AS verified,
      u.telegram_linked_at AS "linkedAt", u.telegram_disabled_reason AS "disabledReason", t.bot_username AS "botUsername",
      (SELECT value='true'::jsonb FROM platform_settings WHERE key='feature_telegram') AS feature
      FROM users u CROSS JOIN telegram_state t WHERE u.id=$1`, [userId]);
    if (!state) throw new ForbiddenException('Привязка Telegram доступна участникам');
    const { feature, ...publicState } = state;
    const enabled = feature && Boolean(telegramToken());
    return { ...publicState, enabled, verified: enabled && state.verified };
  }

  async issue(userId: string) {
    return this.db.transaction(async client => {
      if (!telegramToken() || !await this.settings.enabled('feature_telegram', client)) {
        throw new ConflictException('Telegram-бот не настроен');
      }
      const { rows: [bot] } = await client.query<{ username: string | null }>('SELECT bot_username AS username FROM telegram_state');
      if (!bot?.username) throw new ConflictException('Telegram-бот не настроен');
      const { rows: [member] } = await client.query<{ pd_consent_version: string | null }>(`SELECT pd_consent_version FROM users
        WHERE id=$1 AND role IN ('BUYER','SELLER') AND status='ACTIVE' FOR UPDATE`, [userId]);
      if (!member) throw new ForbiddenException('Привязка Telegram доступна участникам');
      if (member.pd_consent_version !== await policyVersion(client)) throw policyRequired();
      await this.expireUnused(client, userId);
      const { rows: [clock] } = await client.query<{ expires: Date }>("SELECT now()+interval '15 minutes' AS expires");
      const token = await this.actions.issue(client, { purpose: 'telegram.link', subjectId: userId, userId, expiresAt: clock.expires });
      return { url: `https://t.me/${bot.username}?start=${token}`, expiresAt: clock.expires };
    });
  }

  async exchange(client: PoolClient, token: string, chatId: string, from: TelegramPerson) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { text: oldLink };
    const hash = hashToken(token);
    const { rows: [tokenOwner] } = await client.query<{ userId: string }>(`
      SELECT user_id AS "userId" FROM action_tokens
      WHERE token_hash=$1 AND purpose='telegram.link' AND used_at IS NULL AND expires_at>now()
    `, [hash]);
    if (!tokenOwner) return { text: oldLink };
    const { rows: [user] } = await client.query<{ name: string; oldChatId: string | null; pd_consent_version: string | null }>(`
      SELECT display_name AS name,telegram_chat_id AS "oldChatId",pd_consent_version FROM users
      WHERE id=$1 AND role IN ('BUYER','SELLER') AND status='ACTIVE' FOR UPDATE
    `, [tokenOwner.userId]);
    if (!user) return { text: oldLink };
    if (user.pd_consent_version !== await policyVersion(client)) return { text: 'Примите актуальное согласие на обработку данных в профиле на сайте.' };
    const { rows: [current] } = await client.query(`SELECT token_hash FROM action_tokens WHERE token_hash=$1 AND purpose='telegram.link'
      AND user_id=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [hash, tokenOwner.userId]);
    if (!current) return { text: oldLink };
    const collision = await client.query(`SELECT 1 FROM users WHERE id<>$1 AND telegram_chat_id IS NOT NULL
      AND (telegram_chat_id=$2 OR telegram_user_id=$3)`, [tokenOwner.userId, chatId, String(from.id)]);
    if (collision.rowCount) return { text: linkTaken };
    const username = observedUsername(from);
    await client.query(`UPDATE users SET telegram_chat_id=$2,telegram_user_id=$3,telegram_username=$4,
      telegram_linked_at=now(),telegram_disabled_at=NULL,telegram_disabled_reason=NULL WHERE id=$1`,
    [tokenOwner.userId, chatId, String(from.id), username]);
    await client.query('UPDATE action_tokens SET used_at=now() WHERE token_hash=$1', [hash]);
    const previous = user.oldChatId && user.oldChatId !== chatId ? user.oldChatId : undefined;
    if (previous) await client.query('DELETE FROM telegram_dialogs WHERE chat_id=$1', [previous]);
    return { text: `Готово: аккаунт ${user.name} на площадке hwforai привязан. Сюда будут приходить вопрос «Актуально?» и уведомления. Команды: /status, /help, /stop`,
      previous, previousText: previous ? `Аккаунт ${user.name} привязан к другому Telegram. Этот чат отключён.` : undefined };
  }

  async findMember(client: Queryable, chatId: string, user: TelegramPerson, lock = false): Promise<LinkedMember | undefined> {
    const { rows: [member] } = await client.query<LinkedMember>(`
      SELECT id,status,telegram_chat_id AS "chatId",display_name AS name FROM users
      WHERE telegram_chat_id=$1 AND telegram_user_id=$2 AND role IN ('BUYER','SELLER') ${lock ? 'FOR UPDATE' : ''}
    `, [chatId, String(user.id)]);
    return member;
  }

  async observeUsername(client: Queryable, chatId: string, from: TelegramPerson): Promise<Nicknames | undefined> {
    const { rows: [result] } = await client.query<Nicknames>(`
      UPDATE users AS u SET telegram_username=$3,
        telegram_verified_at=CASE WHEN lower(u.telegram)=lower($3) THEN now() END,
        telegram_verified_version=CASE WHEN lower(u.telegram)=lower($3) THEN u.telegram_version END
      WHERE u.telegram_chat_id=$1 AND u.telegram_user_id=$2 AND u.status='ACTIVE' AND u.role IN ('BUYER','SELLER')
      RETURNING u.telegram AS "profileUsername", u.telegram_username AS username, telegram_handle_verified(u) AS verified
    `, [chatId, String(from.id), observedUsername(from)]);
    return result;
  }

  async adoptUsername(client: PoolClient, chatId: string, from: TelegramPerson, expected: string) {
    const username = observedUsername(from);
    if (!username || !TELEGRAM_PATTERN.test(username) || username.toLowerCase() !== expected.toLowerCase()) {
      return 'Имя пользователя изменилось. Используйте кнопку с актуальным именем.';
    }
    const { rows: [user] } = await client.query<{ id: string; telegram: string | null; consent: string | null }>(`
      SELECT id,telegram,pd_consent_version AS consent FROM users
      WHERE telegram_chat_id=$1 AND telegram_user_id=$2 AND status='ACTIVE' AND role IN ('BUYER','SELLER') FOR UPDATE
    `, [chatId, String(from.id)]);
    if (!user) return 'Telegram отвязан от профиля.';
    if (user.consent !== await policyVersion(client)) return 'Примите актуальное согласие на обработку данных в профиле на сайте.';
    if (user.telegram?.toLowerCase() !== username.toLowerCase()) {
      // The profile trigger bumps the version and records the previous handle.
      await client.query('UPDATE users SET telegram=$2,updated_at=now() WHERE id=$1', [user.id, username]);
    }
    return `Telegram @${username} подтверждён. Собеседники увидят этот ник после согласия на обмен.`;
  }

  async disable(client: PoolClient, userId: string, reason: DisableReason, expectedChat?: string): Promise<boolean> {
    const result = await client.query(`UPDATE users SET telegram_chat_id=NULL,telegram_user_id=NULL,telegram_username=NULL,
      telegram_linked_at=NULL,telegram_disabled_at=now(),telegram_disabled_reason=$2
      WHERE id=$1 AND telegram_chat_id IS NOT NULL AND ($3::bigint IS NULL OR telegram_chat_id=$3)`,
    [userId, reason, expectedChat ?? null]);
    if (!result.rowCount) return false;
    await this.expireUnused(client, userId);
    await client.query('DELETE FROM telegram_dialogs WHERE user_id=$1', [userId]);
    const { rows } = await client.query<{ id: string }>(`UPDATE notification_deliveries d SET status='SKIPPED'
      FROM notifications n WHERE d.notification_id=n.id AND n.user_id=$1 AND d.channel='TELEGRAM' AND d.status='PENDING' RETURNING d.id`, [userId]);
    await releaseTelegramFallbacks(client, rows.map(row => row.id), false);
    if (reason === 'BOT_BLOCKED' || reason === 'CHAT_NOT_FOUND') {
      await this.notifications.notify(client, userId, {
        kind: 'telegram.disabled', title: 'Telegram отключён',
        body: reason === 'BOT_BLOCKED'
          ? 'Бот заблокирован. Уведомления приходят на почту. Подключить снова можно в профиле.'
          : 'Чат бота недоступен. Уведомления приходят на почту. Подключить снова можно в профиле.',
        actions: [{ label: 'Открыть профиль', href: '/account' }], channels: ['EMAIL'],
      });
    }
    return true;
  }

  async unlink(userId: string, actor?: StaffSession<'ADMIN'>, reason?: string) {
    return this.db.transaction(async client => {
      if (actor) await lockTrustStaff(client, actor);
      if (!await this.disable(client, userId, actor ? 'ADMIN' : 'PROFILE_UNLINK')) {
        throw new ConflictException('Telegram не привязан');
      }
      if (actor) await auditExchange(client, actor, 'user', userId, 'telegram-unlink', { linked: true }, { linked: false }, reason);
      return { linked: false };
    });
  }

  private async expireUnused(client: Queryable, userId: string) {
    await client.query("UPDATE action_tokens SET used_at=now() WHERE user_id=$1 AND purpose='telegram.link' AND used_at IS NULL", [userId]);
  }
}
