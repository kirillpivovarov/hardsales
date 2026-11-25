import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { addWorkDays, evaluatePair } from '../dist/matching/matching.rules.js';

const compatibility = JSON.parse(readFileSync(new URL('../seeds/exchange_data/payment_compatibility.json', import.meta.url)));
const day = '2026-11-27';
const rates = { RUB: '0.01050000', USD: '1.00000000', KZT: null };

const seller = {
  id: 's', title: 'NVIDIA H100 SXM', kind: 'SELL', owner_id: 'seller', model_id: 'h100-sxm',
  analog_model_ids: [], condition: 'NEW', quantity: 8, min_lot: 2, ship_days: null,
  origin_scope: 'COUNTRY', origin_country: 'RU', destination_country: null,
  counterparty: 'ANY', participant_type: 'COMPANY', delivery_by: null,
  price_mode: 'FIXED', price: '1890000.00', currency: 'RUB', payment_terms: [],
  payment_methods: ['BANK_TRANSFER'], representation: 'DIRECT',
};
const buyer = {
  ...seller, id: 'b', title: 'Заявка на NVIDIA H100 SXM', kind: 'BUY', owner_id: 'buyer', quantity: 4,
  min_lot: 1, origin_scope: 'DOMESTIC', destination_country: 'RU', delivery_by: '2026-12-01',
  price: '1000000.00',
};
const pair = (sell = {}, buy = {}) => evaluatePair({ ...seller, ...sell }, { ...buyer, ...buy }, day, rates, compatibility);

test('compares unit prices across quantities and currencies at exact five percent', () => {
  assert.equal(pair().type, 'FULL');
  const usdSeller = { price: '208.00', quantity: 2, currency: 'USD' };
  const usdBuyer = { price: '1000.00', quantity: 10, currency: 'USD' };
  assert.deepEqual(pair(usdSeller, usdBuyer).mismatches, [
    { key: 'PRICE', text: 'Цена выше бюджета покупателя на 4,0 % (в пределах 5 %)' },
  ]);
  assert.equal(pair({ ...usdSeller, price: '210.00' }, usdBuyer).type, 'PARTIAL');
  assert.equal(pair({ ...usdSeller, price: '210.01' }, usdBuyer), null);
  assert.equal(pair({ currency: 'USD', price: '20000.00' }).type, 'FULL');
  assert.deepEqual(pair({ currency: 'KZT' }).mismatches.map(item => item.key), ['PRICE_UNKNOWN']);
  assert.deepEqual(pair({}, { price_mode: 'NEGOTIABLE', price: null }).mismatches.map(item => item.key), ['PRICE_UNKNOWN']);
});

test('checks analog selection, ranked condition, bilateral quantities and account type', () => {
  assert.equal(pair({}, { model_id: 'h200-sxm' }), null);
  assert.equal(pair({}, { model_id: 'h200-sxm', analog_model_ids: ['h100-sxm'] }).type, 'FULL');
  assert.equal(pair({ condition: 'USED' }, { condition: 'REFURBISHED' }), null);
  assert.equal(pair({}, { condition: 'REFURBISHED' }).type, 'FULL');
  assert.equal(pair({ quantity: 3 }, { min_lot: 4 }), null);
  assert.equal(pair({ min_lot: 5 }), null);
  assert.equal(pair({ counterparty: 'COMPANY' }, { participant_type: 'INDIVIDUAL' }), null);
  assert.equal(pair({ participant_type: 'INDIVIDUAL' }, { counterparty: 'COMPANY' }), null);
});

test('accepts flexible logistics and distinguishes weekends from work days', () => {
  assert.equal(pair({ origin_country: 'CN' }, { origin_scope: 'COUNTRY', origin_country: 'KZ' }), null);
  assert.equal(pair({ origin_scope: 'ANY', origin_country: null }, { origin_scope: 'COUNTRY', origin_country: 'KZ' }).type, 'FULL');
  assert.equal(pair({ origin_scope: null }).type, 'FULL');
  assert.equal(pair({ destination_country: 'CN' }), null);
  assert.equal(addWorkDays(day, 0), day);
  assert.equal(addWorkDays(day, 2), '2026-12-01');
  assert.equal(pair({ ship_days: 2 }).type, 'FULL');
  assert.equal(pair({ ship_days: 3 }), null);
});

test('falls back to methods until both sides select terms, applying dataset rules and suppression', () => {
  const above = { payment_terms: ['PREPAY_100'] };
  assert.equal(pair(above).type, 'FULL');
  const gap = pair(above, { payment_terms: ['PAY_AFTER_INSPECTION'] });
  assert.equal(gap.type, 'PARTIAL');
  assert.deepEqual(gap.gap.rows.map(row => row.id), ['c1', 'c5', 'c9']);
  assert.deepEqual(gap.gap.partners, ['INSPECTION', 'ESCROW']);
  assert.deepEqual(pair({ ...above, representation: 'AGENT' }, { payment_terms: ['LC_CONFIRMED'] })
    .gap.rows.map(row => row.id), ['c8']);
  assert.deepEqual(pair({ payment_methods: ['CARD'] }).gap.rows.map(row => row.id), ['c0']);
  assert.deepEqual(pair(above, above).commonTerms, ['PREPAY_100']);
});
