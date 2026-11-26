import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { addWorkDays, evaluatePair, explainPair } from '../dist/matching/matching.rules.js';

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

test('operator explanations agree with the automatic eligibility and price decision across 200 pairs', () => {
  let state = 157091;
  const sample = options => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return options[(state >>> 16) % options.length];
  };
  for (let index = 0; index < 200; index++) {
    const sell = { ...seller,
      model_id: sample(['h100-sxm', 'h200-sxm']), quantity: sample([2, 4, 6, 8]), min_lot: 2,
      price: sample(['305.00', '430.00', '440.00', '500.00']), currency: 'USD',
      condition: sample(['NEW', 'USED', 'REFURBISHED']), origin_country: sample(['RU', 'KZ']),
      destination_country: sample([null, 'RU', 'KZ']), ship_days: sample([null, 0, 2, 3]),
      counterparty: sample(['ANY', 'COMPANY']), payment_methods: sample([['BANK_TRANSFER'], ['CASH']]),
    };
    const buy = { ...buyer, price: '400.00', currency: 'USD', min_lot: sample([1, 2, 3]),
      analog_model_ids: sample([[], ['h200-sxm']]), participant_type: sample(['COMPANY', 'INDIVIDUAL']),
      condition: sample(['NEW', 'REFURBISHED', 'USED']), origin_scope: sample(['DOMESTIC', 'ANY']),
      delivery_by: sample(['2026-12-01', '2026-12-08']),
    };
    const automatic = evaluatePair(sell, buy, day, rates, compatibility);
    const explanation = explainPair(sell, buy, day, rates, compatibility);
    assert.equal(explanation.failures.length === 0, automatic !== null, JSON.stringify({ sell, buy }));
    assert.deepEqual(explanation.evaluation, automatic);
  }
});

test('near-miss explanation preserves numeric excess and distinguishes an inferred model from an unselected analog', () => {
  const sell = { ...seller, model_id: 'hgx-h200-8', price: '896.00', currency: 'USD' };
  const buy = { ...buyer, model_id: 'dgx-h200', price: '400.00', currency: 'USD' };
  const models = { sell: { id: sell.model_id, nameRu: 'HGX H200', groups: ['h200-server'] },
    buy: { id: buy.model_id, nameRu: 'DGX H200', groups: ['h200-server'] } };
  const analog = explainPair(sell, buy, day, rates, compatibility, models);
  assert.deepEqual(analog.failures.map(reason => reason.key), ['MODEL_ANALOG', 'PRICE_OVER']);
  assert.equal(analog.priceOver, 0.12);
  assert.equal(analog.failures[1].text, 'Цена выше бюджета на 12,0 %');
  const inferred = explainPair({ ...sell, model_id: null, price: '800.00' }, buy, day, rates, compatibility, models);
  assert.deepEqual(inferred.failures.map(reason => reason.key), ['MODEL_MISSING']);
  assert.equal(inferred.failures[0].detail.modelId, sell.model_id);
});
