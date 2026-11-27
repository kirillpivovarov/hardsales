import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { TELEGRAM_PATTERN } from '../auth/auth.dto';
import { DatabaseService } from '../database/database.service';
import { ExchangeActions } from '../exchange/actions';
import { ActualityJobs } from '../exchange/actuality.jobs';
import { dealFailureReasons } from '../exchange/deals.service';
import type { NotificationAction } from '../exchange/notifications';
import { PlatformSettings } from '../exchange/platform-settings';
import { declineReasons } from '../matching/matching.rules';
import { TelegramApi, type TelegramButton, type TelegramCallback, type TelegramKeyboard, type TelegramMessage,
  type TelegramPerson, type TelegramUpdate } from './telegram-api';
import { callback, noticeKeyboard, parseActualityChange, parseDecimal, urlButton, type TelegramNotice } from './telegram-buttons';
import { telegramToken } from './telegram-config';
import { TelegramLinks } from './telegram-links';

type Effect = () => Promise<unknown>;
type DialogKind = 'ACTUALITY_CHANGE' | 'PRINCIPAL_AMOUNT';
type Dialogue = { tokenIndex: number; notificationId: string; expects: DialogKind; sourceId: string;
  promptId: string; expired: boolean };
type Incoming = Pick<TelegramMessage, 'chat' | 'message_id' | 'text' | 'reply_to_message'> & { from: TelegramPerson };

const withdrawReasons = [
  ['Продано через площадку', 'SOLD_PLATFORM'], ['Продано вне площадки', 'SOLD_OUTSIDE'], ['Отменено', 'CANCELLED'],
] as const;
const welcome = 'Это бот площадки hwforai. Чтобы получать вопрос «Актуально?» и уведомления, откройте профиль на сайте и нажмите «Подключить Telegram».';
const help = `${welcome}\n\n/start — начать\n/status — вопросы об актуальности\n/stop — отключить уведомления\n/help — команды бота`;
const profileUnavailable = 'Профиль недоступен';

function privateMessage(value: TelegramMessage | undefined, from = value?.from): value is Incoming {
  return value?.chat?.type === 'private' && Number.isSafeInteger(value.chat.id) && value.chat.id > 0 &&
    Number.isSafeInteger(value.message_id) && value.message_id >= 0 && from?.id === value.chat.id && !from.is_bot;
}

function callbackText(error: HttpException) {
  const body = error.getResponse();
  const text = typeof body === 'string' ? body : (body as { message?: unknown }).message;
  if (error.getStatus() === 409 && text === 'Ссылка уже использована') return 'Уже отвечено';
  return typeof text === 'string' ? text : 'Не удалось выполнить действие. Повторите на сайте.';
}

@Injectable()
export class TelegramUpdates {
  private readonly logger = new Logger(TelegramUpdates.name);
  private effects = Promise.resolve();

  constructor(private readonly db: DatabaseService, private readonly settings: PlatformSettings,
    private readonly links: TelegramLinks, private readonly actions: ExchangeActions,
    private readonly actuality: ActualityJobs, private readonly api: TelegramApi) {}

  async receive(raw: unknown): Promise<void> {
    const update = raw as TelegramUpdate | null;
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new BadRequestException('Некорректное обновление Telegram');
    }
    const kind = update.callback_query ? 'CALLBACK' : update.message ? 'MESSAGE' : 'OTHER';
    const planned = await this.db.transaction(async client => {
      await client.query("SET LOCAL lock_timeout='4s'");
      await client.query("SET LOCAL statement_timeout='4s'");
      const { rowCount } = await client.query(`INSERT INTO telegram_updates(update_id,kind) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [update.update_id, kind]);
      if (!rowCount || !telegramToken() || !await this.settings.enabled('feature_telegram', client)) return [];
      let answer: Effect[];
      let chatId: number;
      let sender: TelegramPerson;
      if (update.callback_query && typeof update.callback_query.id === 'string' &&
        privateMessage(update.callback_query.message, update.callback_query.from)) {
        chatId = update.callback_query.message.chat.id;
        sender = update.callback_query.from;
        await this.lockConversation(client, chatId);
        answer = await this.onCallback(client, update.callback_query, update.callback_query.message);
      } else if (privateMessage(update.message)) {
        chatId = update.message.chat.id;
        sender = update.message.from;
        await this.lockConversation(client, chatId);
        answer = await this.onMessage(client, update.message);
      }
      else return [];
      // Business actions lock the actor and any counterparty in their normal order before this single-user write.
      const names = await this.links.observeUsername(client, String(chatId), sender);
      if (names && !names.verified && names.username && TELEGRAM_PATTERN.test(names.username)) {
        const profile = names.profileUsername ? `@${names.profileUsername}` : 'не указан';
        answer.push(this.reply(String(chatId),
          `Ник в профиле площадки (${profile}) не совпадает с вашим Telegram @${names.username}. Для обмена контактами можно выбрать актуальный ник.`,
          { text: `Использовать @${names.username}`, callback_data: `u:${names.username}` }));
      }
      await client.query('UPDATE telegram_updates SET handled=true WHERE update_id=$1', [update.update_id]);
      return answer;
    });
    if (planned.length) {
      // The API is called after the update and all state changes are committed.
      this.effects = this.effects.then(async () => {
        for (const effect of planned) {
          try { await effect(); } catch { this.logger.warn('Не удалось ответить на обновление Telegram'); }
        }
      });
    }
  }

  private async lockConversation(client: PoolClient, chatId: number) {
    // Serialize private updates for the same Telegram identity across application replicas.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 49011))', [String(chatId)]);
  }

  private reply(chatId: string, text: string, button?: TelegramButton): Effect {
    const markup = button ? { reply_markup: { inline_keyboard: [[button]] } } : {};
    return () => this.api.call('sendMessage', { chat_id: chatId, text, ...markup, link_preview_options: { is_disabled: true } });
  }

  private showProfile(chatId: string, text = help): Effect {
    return this.reply(chatId, text, urlButton('Открыть профиль', '/account'));
  }

  private callbackAnswer(callbackId: string, text?: string): Effect {
    return () => this.api.call('answerCallbackQuery', {
      callback_query_id: callbackId, ...(text ? { text: Array.from(text).slice(0, 200).join('') } : {}),
    });
  }

  private edit(chatId: string, messageId: number, keyboard: TelegramKeyboard = { inline_keyboard: [] }): Effect {
    return () => this.api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
  }

  private async onMessage(client: PoolClient, message: Incoming): Promise<Effect[]> {
    const chatId = String(message.chat.id);
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const start = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?$/i.exec(text);
    if (start) {
      if (!start[1]) return [this.showProfile(chatId, welcome)];
      const result = await this.links.exchange(client, start[1], chatId, message.from);
      const planned = [this.reply(chatId, result.text)];
      if (result.previous && result.previousText) {
        const previous = result.previous;
        const previousText = result.previousText;
        planned.push(async () => {
          const { rowCount } = await this.db.query('SELECT 1 FROM users WHERE telegram_chat_id=$1', [previous]);
          if (!rowCount) await this.reply(previous, previousText)();
        });
      }
      return planned;
    }
    const user = await this.links.findMember(client, chatId, message.from);
    if (/^\/stop(?:@[A-Za-z0-9_]+)?$/i.test(text) && user) {
      if (!await this.links.disable(client, user.id, 'USER_STOP', chatId)) return [this.showProfile(chatId)];
      return [this.showProfile(chatId, 'Telegram отключён. Уведомления будут приходить на почту. Подключить снова можно в профиле на сайте.')];
    }
    if (/^\/help(?:@[A-Za-z0-9_]+)?$/i.test(text) || !user) return [this.showProfile(chatId)];
    if (user.status !== 'ACTIVE') return [this.reply(chatId, profileUnavailable)];
    if (/^\/status(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
      if ((await this.links.findMember(client, chatId, message.from, true))?.status !== 'ACTIVE') {
        return [this.reply(chatId, profileUnavailable)];
      }
      const summary = await this.actuality.telegramStatus(client, user.id);
      return summary ? [this.reply(chatId, summary)] : [];
    }
    const { rows: [dialog] } = await client.query<Dialogue>(`
      SELECT action_index AS "tokenIndex",notification_id AS "notificationId",expects,
        source_message_id AS "sourceId",prompt_message_id AS "promptId",expires_at<=now() AS expired
      FROM telegram_dialogs WHERE chat_id=$1 AND user_id=$2`, [chatId, user.id]);
    if (!dialog || (message.reply_to_message && String(message.reply_to_message.message_id) !== dialog.promptId)) {
      return [this.showProfile(chatId)];
    }
    if (dialog.expired) {
      await client.query('DELETE FROM telegram_dialogs WHERE chat_id=$1', [chatId]);
      return [this.reply(chatId, 'Время ответа истекло. Нажмите кнопку ещё раз.')];
    }
    const value = dialog.expects === 'PRINCIPAL_AMOUNT' ? parseDecimal(text) : null;
    const body = dialog.expects === 'ACTUALITY_CHANGE' ? parseActualityChange(text)
      : value !== null ? { answer: 'OTHER', value: String(value) } : null;
    if (!body) return [this.reply(chatId, dialog.expects === 'ACTUALITY_CHANGE'
      ? 'Не понял. Пример: цена 1890000; количество 6' : 'Не понял. Напишите число, например 4,5.')];
    const notice = await this.findNotification(client, user.id, dialog.notificationId);
    const action = notice?.actions[dialog.tokenIndex];
    if (!action?.token) {
      await client.query('DELETE FROM telegram_dialogs WHERE chat_id=$1', [chatId]);
      return [this.reply(chatId, 'Время ответа истекло. Нажмите кнопку ещё раз.')];
    }
    const planned = await this.execute(client, chatId, user.id, action, body, Number(dialog.sourceId));
    if (!planned.retryDialog) await client.query('DELETE FROM telegram_dialogs WHERE chat_id=$1', [chatId]);
    return planned.effects;
  }

  private async findNotification(client: PoolClient, userId: string, id: string): Promise<TelegramNotice | undefined> {
    const { rows: [notice] } = await client.query<TelegramNotice>(`
      SELECT id,kind,title,body,actions,payload FROM notifications WHERE id=$1 AND user_id=$2`, [id, userId]);
    return notice;
  }

  private async onCallback(client: PoolClient, query: TelegramCallback, message: TelegramMessage): Promise<Effect[]> {
    const chatId = String(message.chat.id);
    const ack = (text?: string) => this.callbackAnswer(query.id, text);
    const nickname = typeof query.data === 'string' && /^u:([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(query.data);
    if (nickname) {
      const result = await this.links.adoptUsername(client, chatId, query.from, nickname[1]);
      return [ack(result)];
    }
    const user = await this.links.findMember(client, chatId, query.from);
    const fields = typeof query.data === 'string' && /^n:([1-9]\d{0,18}):([0-9]|[1-4][0-9]):([A-Z0-9]{1,8})$/.exec(query.data);
    if (!user || !fields || BigInt(fields[1]) > 9223372036854775807n) return [ack('Эта кнопка не для вас')];
    if (user.status !== 'ACTIVE') return [ack(profileUnavailable)];
    const notice = await this.findNotification(client, user.id, fields[1]);
    const index = Number(fields[2]);
    const code = fields[3];
    const action = notice?.actions[index];
    if (!action?.token || !notice) return [ack('Эта кнопка не для вас')];
    try {
      await this.actions.limitTelegram(client, user.id);
      if (code === 'BACK') return [ack(), this.edit(chatId, message.message_id, noticeKeyboard(notice))];
      if ((action.action === 'listing.actuality' && code === 'C') || (action.action === 'principal.answer' && code === 'CHANGE')) {
        if ((await this.links.findMember(client, chatId, query.from, true))?.status !== 'ACTIVE') return [ack(profileUnavailable)];
        await this.actions.inspectForUser(client, action.token, user.id);
        const kind = code === 'C' ? 'ACTUALITY_CHANGE' : 'PRINCIPAL_AMOUNT';
        return [ack(), await this.prompt(client, chatId, user.id, notice.id, index, kind, message.message_id)];
      }
      const reasons = this.reasonKeyboard(action, code, notice.id, index);
      if (reasons) {
        await this.actions.inspectForUser(client, action.token, user.id);
        return [ack(), this.edit(chatId, message.message_id, reasons)];
      }
      const body = this.actionBody(action, code);
      if (!body) return [ack('Эта кнопка недоступна')];
      const beforeExecute = action.action === 'chat.reveal'
        ? () => this.links.observeUsername(client, chatId, query.from) : undefined;
      const planned = await this.execute(client, chatId, user.id, action, body, message.message_id, beforeExecute);
      return [ack(planned.text), ...planned.effects];
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      const text = callbackText(error);
      return [ack(text), ...this.actionError(chatId, message.message_id, error, text)];
    }
  }

  private actionBody(action: NotificationAction, code: string): object | null {
    if (action.action === 'listing.actuality') {
      if (code === 'A') return { answer: 'ACTUAL' };
      const reason = /^W[0-2]$/.test(code) && withdrawReasons[Number(code[1])]?.[1];
      return reason ? { answer: 'WITHDRAWN', reason } : null;
    }
    if (action.action === 'match.decline') {
      const reason = /^M[0-6]$/.test(code) && declineReasons[Number(code[1])];
      return reason ? { reason } : null;
    }
    if (action.action === 'chat.reveal') return code === 'YES' ? { action: 'ACCEPT', rulesAccepted: true }
      : code === 'NO' ? { action: 'DECLINE' } : null;
    if (action.action === 'principal.answer') return ['YES', 'NO'].includes(code) ? { answer: code } : null;
    if (action.action === 'deal.status') {
      if (code === 'LIVE') return { status: 'NEGOTIATING' };
      const reason = /^D[0-6]$/.test(code) && dealFailureReasons[Number(code[1])];
      return reason ? { status: 'FAILED', reason } : null;
    }
    return code === 'OK' ? {} : null;
  }

  private reasonKeyboard(action: NotificationAction, code: string, id: string, index: number): TelegramKeyboard | undefined {
    const reasons = action.action === 'listing.actuality' && code === 'W' ? withdrawReasons.map(([label]) => label)
      : action.action === 'match.decline' && code === 'WHY' ? declineReasons
      : action.action === 'deal.status' && code === 'WHY' ? dealFailureReasons : undefined;
    if (!reasons) return undefined;
    const prefix = action.action === 'listing.actuality' ? 'W' : action.action === 'match.decline' ? 'M' : 'D';
    return { inline_keyboard: [...reasons.map((reason, value) => [callback(reason, id, index, prefix + value)]),
      [callback('Назад', id, index, 'BACK')]] };
  }

  private async prompt(client: PoolClient, chatId: string, userId: string, notificationId: string, index: number,
    kind: DialogKind, sourceMessage: number): Promise<Effect> {
    const { rows: [state] } = await client.query<{ expires: string }>(`
      INSERT INTO telegram_dialogs(chat_id,user_id,notification_id,action_index,expects,source_message_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()+interval '15 minutes') ON CONFLICT(chat_id) DO UPDATE SET
        user_id=EXCLUDED.user_id,notification_id=EXCLUDED.notification_id,action_index=EXCLUDED.action_index,
        expects=EXCLUDED.expects,source_message_id=EXCLUDED.source_message_id,prompt_message_id=0,expires_at=EXCLUDED.expires_at
      RETURNING expires_at::text AS expires`, [chatId, userId, notificationId, index, kind, sourceMessage]);
    return async () => {
      const ask = await this.api.call<TelegramMessage>('sendMessage', { chat_id: chatId, reply_markup: { force_reply: true },
        text: kind === 'ACTUALITY_CHANGE'
          ? 'Напишите новую цену за шт. и (или) количество. Например: цена 1890000; количество 6'
          : 'Напишите согласованный размер вознаграждения. Например: 4,5',
      });
      await this.db.query('UPDATE telegram_dialogs SET prompt_message_id=$2 WHERE chat_id=$1 AND expires_at=$3',
        [chatId, ask.message_id, state.expires]);
    };
  }

  private async execute(client: PoolClient, chatId: string, userId: string, action: NotificationAction,
    body: object, messageId: number, beforeExecute?: () => Promise<unknown>): Promise<{ text: string; effects: Effect[]; retryDialog?: boolean }> {
    await client.query('SAVEPOINT telegram_button');
    try {
      const result = await this.actions.runForUser(action.token!, body, userId, client, chatId, beforeExecute) as { chatId?: string; message?: string };
      await client.query('RELEASE SAVEPOINT telegram_button');
      const text = action.action === 'listing.actuality' && (body as { answer?: string }).answer === 'WITHDRAWN' ? 'Объявление снято'
        : action.action === 'listing.extend' ? 'Срок продлён' : result.chatId ? 'Чат открыт' : result.message ?? 'Подтверждено';
      const button = result.chatId ? urlButton('Открыть чат', `/chats/${result.chatId}`) : undefined;
      return { text, effects: [this.edit(chatId, messageId), this.reply(chatId, text, button)] };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT telegram_button');
      await client.query('RELEASE SAVEPOINT telegram_button');
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      const text = callbackText(error);
      return { text, effects: this.actionError(chatId, messageId, error, text), retryDialog: error.getStatus() === 400 };
    }
  }

  private actionError(chatId: string, messageId: number, error: HttpException, text: string): Effect[] {
    const status = error.getStatus();
    if (status === 410) return [this.edit(chatId, messageId), this.reply(chatId, `${text}. Объявление можно вернуть на сайте.`,
      urlButton('Мои объявления', '/my-listings'))];
    return status === 409 ? [this.edit(chatId, messageId), this.reply(chatId, text)] : [this.reply(chatId, text)];
  }
}
