import { Injectable } from '@nestjs/common';
import { telegramApiOrigin, telegramToken } from './telegram-config';

export type TelegramButton = { text: string; callback_data: string } | { text: string; url: string };
export type TelegramKeyboard = { inline_keyboard: TelegramButton[][] };
export type TelegramReplyMarkup = TelegramKeyboard | { force_reply: true; selective?: boolean };
export type TelegramPerson = { id: number; username?: string; is_bot?: boolean };
export type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramPerson;
  text?: string;
  reply_to_message?: { message_id: number };
};
export type TelegramCallback = { id: string; from: TelegramPerson; message?: TelegramMessage; data?: string };
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback };
export const allowedUpdates = ['message', 'callback_query'];

export class TelegramApiError extends Error {
  constructor(readonly status: number, readonly retryAfter = 0, readonly chatNotFound = false) {
    super(status ? `Telegram Bot API ${status}` : 'Telegram Bot API недоступен');
  }
}

type Method = 'getMe' | 'setWebhook' | 'deleteWebhook' | 'getWebhookInfo' | 'getUpdates' | 'sendMessage' |
  'editMessageReplyMarkup' | 'answerCallbackQuery';

type TelegramResponse<T> = { ok: true; result: T } | {
  ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number };
};

@Injectable()
export class TelegramApi {
  async call<T>(method: Method, body: object = {}, signal?: AbortSignal): Promise<T> {
    const token = telegramToken();
    if (!token) throw new TelegramApiError(0);
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 10_000);
    let response: Response;
    let result: TelegramResponse<T>;
    try {
      response = await fetch(`${telegramApiOrigin()}/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      result = await response.json() as TelegramResponse<T>;
    } catch {
      // Fetch exceptions can include the full credential-bearing URL.
      throw new TelegramApiError(0);
    }
    if (response.ok && result?.ok === true) return result.result;
    const failed = result && result.ok === false ? result : undefined;
    const retry = failed?.parameters?.retry_after;
    const status = failed?.error_code;
    throw new TelegramApiError(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : response.status,
      Number.isSafeInteger(retry) && Number(retry) > 0 ? Math.min(Number(retry), 2_147_483_647) : 0,
      typeof failed?.description === 'string' && /\bchat not found\b/i.test(failed.description));
  }
}
