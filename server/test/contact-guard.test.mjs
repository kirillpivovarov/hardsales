import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { detectContacts, detectSplitContact, requestsOutsideChat } = require('../dist/contact-guard/detect');

test('contact guard detects normalized Russian and English contact formats', () => {
  const variants = {
    PHONE: [
      '8 900 123 45 67', '8(900)123-45-67', '8.900.123.45.67', '89001234567', '+7 900 123‑45‑67',
      'восемь девятьсот сто двадцать три сорок пять шестьдесят семь',
      'plus seven nine zero zero one two three four five six seven', '8 9о0 12з 45 67',
      '8900\u200b1234567', '８９００１２３４５６７',
    ],
    EMAIL: ['ivan собака mail точка ru', 'name (at) mail dot ru', 'name[at]mail[.]ru', 'ivan@example.com'],
    TELEGRAM: ['телега maxim_pro', 'tg: maxim_pro', 't.mе/maxim_pro', '@maxim_pro', 'te1egram: maxim_pro'],
    MESSENGER: ['валюту обсудим в WhatsApp vlad_123', 'wa.me/79001234567', 'Discord maxim_pro'],
    LINK: ['https://shop.example/item', 'www.shop.example/item', 'склад.рф', 'shop.c0m'],
  };
  for (const [kind, texts] of Object.entries(variants)) {
    for (const text of texts) assert.ok(detectContacts(text).includes(kind), JSON.stringify({ kind, text }));
  }
  assert.deepEqual(detectContacts('мой телеграмм WhatsApp +79001234567'), ['PHONE', 'MESSENGER']);
});

test('part numbers, dates, units, currency and short serials remain searchable and chat-safe', () => {
  for (const body of [
    'цена 1 890 000 руб за 8 шт, H100 SXM 80 ГБ, поставка до 08.02.2027',
    'SSD PM9A3 3,84 ТБ, артикул MZQL23T8HCLS, 240 шт',
    'Сумма 1 897 000 000 ₽ за весь склад',
    'Первый срок 08.02.2027 второй срок 2027-02-09',
    'R760xa и ConnectX-7',
    'Серийный номер 12345678',
    'Документ № 12345678901',
    'Зафиксировали стоимость 100000000USD',
  ]) assert.deepEqual(detectContacts(body), [], body);
});

test('split contacts are blocked on completion and contact-free off-platform prompts are marked', () => {
  assert.deepEqual(detectSplitContact(['8900', '123'], '4567'), ['PHONE', 'SPLIT']);
  assert.deepEqual(detectSplitContact(['Старое сообщение с 89001234561', '8900', '123'], '4567'), ['PHONE', 'SPLIT']);
  assert.deepEqual(detectSplitContact(['@maxi'], 'm_pro'), ['TELEGRAM', 'SPLIT']);
  assert.deepEqual(detectSplitContact(['89001234567'], 'Здравствуйте'), []);
  assert.deepEqual(detectSplitContact(['8900'], '123'), []);
  assert.equal(requestsOutsideChat('Напиши в Telegram'), true);
  assert.deepEqual(detectContacts('Напиши в Telegram'), []);
  assert.equal(requestsOutsideChat('Можно отгрузить в Москву?'), false);
});
