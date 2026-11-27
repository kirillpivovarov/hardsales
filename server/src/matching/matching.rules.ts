export type ListingForMatch = {
  id: string; title: string; kind: 'SELL' | 'BUY'; owner_id: string;
  model_id: string | null; analog_model_ids: string[]; condition: 'NEW' | 'REFURBISHED' | 'USED' | 'ANY';
  quantity: number; min_lot: number; ship_days: number | null;
  origin_scope: string | null; origin_country: string | null; destination_country: string | null;
  counterparty: 'COMPANY' | 'ANY'; participant_type: 'COMPANY' | 'INDIVIDUAL';
  delivery_by: string | null; price_mode: 'FIXED' | 'NEGOTIABLE'; price: string | null;
  currency: string; payment_terms: string[]; payment_methods: string[]; representation: string;
};

type CompatibilityTool = {
  id: string; seller_wants_ru: string; buyer_wants_ru: string; tool_ru: string; suggest_terms: string[]; partner: string;
};
type CompatibilityRule = CompatibilityTool & {
  seller_terms: string[]; buyer_terms: string[]; seller_representation: string | null; suppresses: string[];
};
export type Compatibility = { rules: CompatibilityRule[]; fallback: CompatibilityTool };
export type Rates = Record<string, string | null>;

export const declineReasons = [
  'Цена не подходит', 'Количество не подходит', 'Срок не подходит', 'Форма оплаты не подходит',
  'Локация не подходит', 'Уже нашли', 'Другое',
] as const;

const conditionRank = { ANY: 0, USED: 1, REFURBISHED: 2, NEW: 3 };
const conditionNames = { ANY: 'любое', USED: 'бывшее в употреблении', REFURBISHED: 'восстановленное', NEW: 'новое' };
const regions = new Intl.DisplayNames('ru', { type: 'region' });

export const nearMissKeys = [
  'MODEL_ANALOG', 'MODEL_MISSING', 'CONDITION', 'QUANTITY', 'ORIGIN', 'DESTINATION', 'COUNTERPARTY', 'SHIP_DATE', 'PRICE_OVER',
] as const;
export type NearMissKey = typeof nearMissKeys[number];
export type MatchFailure = { key: NearMissKey | 'MODEL_INCOMPATIBLE' | 'INVALID_PAIR'; text: string; detail: object };
export type MatchModel = { id: string; nameRu: string; nameEn: string; groups: string[] };
type ModelEvidence = { sell: MatchModel | null; buy: MatchModel | null };

export function matchRegion(code: string | null) {
  return code ? regions.of(code) ?? code : 'любая страна';
}

function intersect(a: string[], b: string[]) {
  return [...new Set(a)].filter(value => b.includes(value));
}

// Dates here are local calendar dates passed from the configured platform clock.
export function addWorkDays(day: string, days: number) {
  const date = new Date(day + 'T00:00:00.000Z');
  for (let elapsed = 0; elapsed < days;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) elapsed++;
  }
  return date.toISOString().slice(0, 10);
}

export function counterpartyEligible(sell: ListingForMatch, buy: ListingForMatch) {
  return (sell.counterparty !== 'COMPANY' || buy.participant_type === 'COMPANY')
    && (buy.counterparty !== 'COMPANY' || sell.participant_type === 'COMPANY');
}

function eligible(sell: ListingForMatch, buy: ListingForMatch, day: string) {
  if (sell.kind !== 'SELL' || buy.kind !== 'BUY' || sell.owner_id === buy.owner_id) return false;
  if (!sell.model_id || !buy.model_id) return false;
  if (sell.model_id !== buy.model_id && !buy.analog_model_ids.includes(sell.model_id)) return false;
  if (conditionRank[sell.condition] < conditionRank[buy.condition]) return false;
  if (sell.quantity < buy.min_lot || buy.quantity < sell.min_lot) return false;
  const requiredOrigin = buy.origin_scope === 'DOMESTIC' ? buy.destination_country : buy.origin_country;
  if (buy.origin_scope !== 'ANY' && sell.origin_scope !== 'ANY' && sell.origin_country !== requiredOrigin) return false;
  if (sell.destination_country !== null && sell.destination_country !== buy.destination_country) return false;
  if (!counterpartyEligible(sell, buy)) return false;
  return sell.ship_days === null || !buy.delivery_by || addWorkDays(day, sell.ship_days) <= buy.delivery_by;
}

function gapFor(sell: ListingForMatch, buy: ListingForMatch, compatibility: Compatibility) {
  const matching = compatibility.rules.filter(rule =>
    (!rule.seller_representation || rule.seller_representation === sell.representation)
    && intersect(rule.seller_terms, sell.payment_terms).length
    && intersect(rule.buyer_terms, buy.payment_terms).length);
  const suppressed = new Set(matching.flatMap(rule => rule.suppresses));
  const permitted = matching.filter(rule => !suppressed.has(rule.id));
  const rows = (permitted.length ? permitted : [compatibility.fallback]).map(rule => ({
    id: rule.id, sellerWants: rule.seller_wants_ru, buyerWants: rule.buyer_wants_ru,
    tool: rule.tool_ru, suggestTerms: rule.suggest_terms, partner: rule.partner,
  }));
  return { rows, partners: [...new Set(rows.map(row => row.partner))] };
}

function fixedDecimal(value: string, digits: number) {
  const [integer, decimal = ''] = value.split('.');
  return BigInt(integer + decimal.padEnd(digits, '0').slice(0, digits));
}

function compareTerms(sell: ListingForMatch, buy: ListingForMatch, rates: Rates, compatibility: Compatibility) {
  const mismatches: { key: 'PRICE' | 'PRICE_UNKNOWN' | 'PAYMENT'; text: string }[] = [];
  let priceOver: number | null = null;
  const sellRate = rates[sell.currency], buyRate = rates[buy.currency];
  if (sell.price_mode !== 'FIXED' || buy.price_mode !== 'FIXED' || sell.price === null || buy.price === null) {
    mismatches.push({ key: 'PRICE_UNKNOWN', text: 'Цена договорная: обсудите в чате' });
  } else if (!sellRate || !buyRate) {
    mismatches.push({ key: 'PRICE_UNKNOWN', text: `Курс валюты ${!sellRate ? sell.currency : buy.currency} не задан: цену нужно сравнить вручную` });
  } else {
    // Compare unit prices exactly, preserving the 5% threshold with decimal FX rates.
    const asking = fixedDecimal(sell.price, 2) * fixedDecimal(sellRate, 8);
    const budget = fixedDecimal(buy.price, 2) * fixedDecimal(buyRate, 8);
    if (asking * 100n > budget * 105n) priceOver = Number(asking - budget) / Number(budget);
    else if (asking > budget) {
      const over = (100 * Number(asking - budget) / Number(budget)).toFixed(1).replace('.', ',');
      mismatches.push({ key: 'PRICE', text: `Цена выше бюджета покупателя на ${over} % (в пределах 5 %)` });
    }
  }
  const formalPayment = sell.payment_terms.length > 0 && buy.payment_terms.length > 0;
  const commonTerms = formalPayment ? intersect(sell.payment_terms, buy.payment_terms) : [];
  const commonMethods = formalPayment ? [] : intersect(sell.payment_methods, buy.payment_methods);
  const gap = commonTerms.length || commonMethods.length ? null : gapFor(sell, buy, compatibility);
  if (gap) mismatches.push({ key: 'PAYMENT', text: `Разрыв по оплате. Его закрывают: ${gap.rows.map(row => row.tool).join(', ')}.` });
  return { terms: { type: mismatches.length ? 'PARTIAL' : 'FULL', mismatches, commonTerms, commonMethods, gap } as const, priceOver };
}

export function evaluatePair(sell: ListingForMatch, buy: ListingForMatch, day: string, rates: Rates, compatibility: Compatibility) {
  if (!eligible(sell, buy, day)) return null;
  const { terms, priceOver } = compareTerms(sell, buy, rates, compatibility);
  return priceOver === null ? terms : null;
}

export function explainPair(sell: ListingForMatch, buy: ListingForMatch, day: string, rates: Rates, compatibility: Compatibility,
  models?: ModelEvidence) {
  const failures: MatchFailure[] = [];
  const add = (key: MatchFailure['key'], text: string, detail: object = {}) => { failures.push({ key, text, detail }); };

  if (sell.kind !== 'SELL' || buy.kind !== 'BUY' || sell.owner_id === buy.owner_id) {
    add('INVALID_PAIR', 'Нужны предложение и заявка от разных участников');
  }
  const sellerModelId = sell.model_id ?? models?.sell?.id;
  const buyerModelId = buy.model_id ?? models?.buy?.id;
  const sharedGroup = models?.sell?.groups.some(group => models.buy?.groups.includes(group)) ?? false;
  const sameModel = Boolean(sellerModelId && buyerModelId && sellerModelId === buyerModelId);
  const allowedAnalog = Boolean(sellerModelId && buy.analog_model_ids.includes(sellerModelId));
  if (!sell.model_id || !buy.model_id) {
    const byTitle = !sell.model_id ? models?.sell : models?.buy;
    if (byTitle && (sameModel || sharedGroup || allowedAnalog)) {
      const owner = !sell.model_id && !buy.model_id ? 'сторон' : !sell.model_id ? 'продавца' : 'покупателя';
      add('MODEL_MISSING', `У ${owner} нет модели из справочника, по названию похоже на ${byTitle.nameRu}`, { modelId: byTitle.id });
    } else add('MODEL_INCOMPATIBLE', 'Не удалось сопоставить модели из объявлений');
  } else if (!sameModel && !allowedAnalog) {
    if (sharedGroup) {
      add('MODEL_ANALOG', `Модель продавца ${models?.sell?.nameRu ?? sell.model_id} не отмечена покупателем как аналог`,
        { sellerModelId, buyerModelId });
    } else add('MODEL_INCOMPATIBLE', 'Модели находятся в разных группах аналогов', { sellerModelId, buyerModelId });
  }

  if (conditionRank[sell.condition] < conditionRank[buy.condition]) {
    add('CONDITION', `Состояние: продавец ${conditionNames[sell.condition]}, покупатель хочет ${conditionNames[buy.condition]}`,
      { sell: sell.condition, buy: buy.condition });
  }
  if (sell.quantity < buy.min_lot) {
    add('QUANTITY', `Количество: у продавца ${sell.quantity} шт. при партии покупателя от ${buy.min_lot}`,
      { quantity: sell.quantity, minLot: buy.min_lot });
  } else if (buy.quantity < sell.min_lot) {
    add('QUANTITY', `Количество: покупателю нужно ${buy.quantity} шт. при партии продавца от ${sell.min_lot}`,
      { quantity: buy.quantity, minLot: sell.min_lot });
  }
  const requiredOrigin = buy.origin_scope === 'DOMESTIC' ? buy.destination_country : buy.origin_country;
  if (buy.origin_scope !== 'ANY' && sell.origin_scope !== 'ANY' && sell.origin_country !== requiredOrigin) {
    add('ORIGIN', `Отгрузка из ${matchRegion(sell.origin_country)}, покупатель ждёт из ${matchRegion(requiredOrigin)}`,
      { actual: sell.origin_country, required: requiredOrigin });
  }
  if (sell.destination_country !== null && sell.destination_country !== buy.destination_country) {
    add('DESTINATION', `Продавец доставляет в ${matchRegion(sell.destination_country)}, покупателю нужно в ${matchRegion(buy.destination_country)}`,
      { actual: sell.destination_country, required: buy.destination_country });
  }
  if (!counterpartyEligible(sell, buy)) add('COUNTERPARTY', 'Сторона принимает только компании');
  const shipDate = sell.ship_days === null ? null : addWorkDays(day, sell.ship_days);
  if (shipDate && buy.delivery_by && shipDate > buy.delivery_by) {
    add('SHIP_DATE', `Отгрузка ${shipDate}, покупателю нужно к ${buy.delivery_by}`, { shipDate, deliveryBy: buy.delivery_by });
  }
  const { terms, priceOver } = compareTerms(sell, buy, rates, compatibility);
  if (priceOver !== null) add('PRICE_OVER', `Цена выше бюджета на ${(100 * priceOver).toFixed(1).replace('.', ',')} %`, { ratio: priceOver });
  return { failures, evaluation: failures.length ? null : terms, terms, priceOver };
}
