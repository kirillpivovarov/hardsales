import { appOrigin, port } from '../config';
import { disclosureTerms } from '../exchange/disclosures.service';
import type { NotificationAction } from '../exchange/notifications';
import type { TelegramButton, TelegramKeyboard } from './telegram-api';
import { telegramApiOrigin } from './telegram-config';

export type TelegramNotice = { id: string; kind: string; title: string; body: string;
  actions: NotificationAction[]; payload: Record<string, unknown> };

export function urlButton(text: string, path: string | undefined): TelegramButton | undefined {
  if (!path || !/^\/(?![\\/])/.test(path)) return undefined;
  const origin = appOrigin() ?? 'http://127.0.0.1:' + port('PORT', 3001);
  const url = new URL(path, origin);
  if (url.origin !== origin) return undefined;
  if (telegramApiOrigin() === 'https://api.telegram.org' &&
    (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.hostname.includes('.'))) return undefined;
  return { text, url: url.href };
}

export function callback(text: string, id: string, index: number, code: string): TelegramButton {
  return { text: clip(text, 95), callback_data: `n:${id}:${index}:${code}` };
}

function clip(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

function optionalRow(button: TelegramButton | undefined): TelegramButton[][] {
  return button ? [[button]] : [];
}

export function noticeKeyboard(notice: TelegramNotice): TelegramKeyboard {
  const button = (text: string, index: number, code: string) => callback(text, notice.id, index, code);
  let inline_keyboard: TelegramButton[][] = [];
  let more = notice.actions.length > 8;
  if (['actuality.ask', 'actuality.remind', 'actuality.bot_status'].includes(notice.kind)) {
    let questions = 0;
    more = false;
    for (const [index, action] of notice.actions.entries()) {
      if (index > 49 || !action.token) continue;
      if (action.action === 'listing.actuality-all') inline_keyboard.push([button(action.label, index, 'OK')]);
      if (action.action === 'listing.actuality') {
        questions++;
        if (questions <= 6) inline_keyboard.push([
          button('Актуально', index, 'A'), button('Изменилась цена или количество', index, 'C'), button('Снято', index, 'W'),
        ]);
      }
      if (action.action === 'listing.extend' && questions <= 6) {
        inline_keyboard.at(-1)?.push(button(action.telegramLabel ?? action.label, index, 'OK'));
      }
    }
    more = questions > 6 || Number(notice.payload.questionCount ?? 0) > 6;
  } else {
    const codes: Record<string, [string, string][]> = {
      'chat.reveal': [['Принять обмен', 'YES'], ['Отклонить', 'NO']],
      'principal.answer': [['Да', 'YES'], ['Нет', 'NO'], ['Другая цифра', 'CHANGE']],
      'deal.status': [['Идут переговоры', 'LIVE'], ['Сорвалось', 'WHY']],
      'match.decline': [['Не подходит', 'WHY']],
    };
    inline_keyboard = notice.actions.slice(0, more ? 7 : 8).flatMap((action, index) => action.token
      ? [(codes[action.action ?? ''] ?? [[action.label, 'OK']]).filter(([, code]) => code !== 'CHANGE' || notice.payload.canChangeFee !== false)
        .map(([text, code]) => button(text, index, code))]
      : optionalRow(urlButton(clip(action.label, 95), action.href)));
  }
  if (more) inline_keyboard.push(...optionalRow(urlButton('Остальные на сайте', notice.kind.startsWith('actuality.') ? '/my-listings' : '/notifications')));
  return { inline_keyboard };
}

export function noticeContent(notice: TelegramNotice): { text: string; reply_markup: TelegramKeyboard } {
  const keyboard = noticeKeyboard(notice);
  const lines = notice.payload.telegramLines;
  const body = Array.isArray(lines) && lines.every(line => typeof line === 'string')
    ? lines.slice(0, 7).join('\n') : notice.body;
  const title = notice.kind === 'actuality.remind' ? 'Напоминание: подтвердите актуальность' : notice.title;
  const revealRules = notice.kind === 'disclosure.request'
    ? '\n\n' + disclosureTerms.map((rule, index) => `${index + 1}. ${rule}`).join('\n') : '';
  const full = `${title}\n\n${body}${revealRules}`;
  if (Array.from(full).length <= 4096) return { text: full, reply_markup: keyboard };
  const fullLink = urlButton('Полностью на сайте', '/notifications');
  return { text: clip(full, 3900) + '\n\nПолностью на сайте',
    reply_markup: { inline_keyboard: [...keyboard.inline_keyboard.slice(0, 7), ...optionalRow(fullLink)] } };
}

export function parseActualityChange(text: string): { answer: 'CHANGED'; price?: number; quantity?: number } | null {
  const parts = text.trim().split(/\s*;\s*|\s*\n\s*|,\s+(?=(?:цена|количество)\s)/iu);
  const output: { answer: 'CHANGED'; price?: number; quantity?: number } = { answer: 'CHANGED' };
  for (const field of parts) {
    const match = /^(цена|количество)\s+([\d.,\s]+)$/iu.exec(field.trim());
    if (!match) return null;
    const key = match[1].toLowerCase() === 'цена' ? 'price' : 'quantity';
    if (output[key] !== undefined) return null;
    const parsed = key === 'price' ? parseDecimal(match[2]) : parseInteger(match[2]);
    if (parsed === null) return null;
    output[key] = parsed;
  }
  return output;
}

function parseInteger(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  if (!/^\d+$|^\d{1,3}(?:[.,]\d{3})+$/.test(normalized)) return null;
  const value = Number(normalized.replace(/[.,]/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  const decimal = /^(.+)[.,](\d{1,2})$/.exec(normalized);
  const integer = parseInteger(decimal ? decimal[1] : normalized);
  if (integer === null) return null;
  const value = decimal ? Number(`${integer}.${decimal[2]}`) : integer;
  return Number.isFinite(value) ? value : null;
}
