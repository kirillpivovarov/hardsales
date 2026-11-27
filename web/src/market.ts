export const countries = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');

export function countryName(country: string, locale = 'ru') {
  if (country === 'KG' && /^ru(?:-|$)/i.test(locale)) return 'Кыргызстан';
  if (!/^[A-Z]{2}$/.test(country)) return country;
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country; }
  catch { return country; }
}

// Fixed commercial priority, followed by the other regional partners and the rest.
const countryPriority = new Map<string, number>([
  ['RU', 0], ['KZ', 1], ['KG', 2], ['UZ', 3],
  ['AM', 4], ['AZ', 4], ['BY', 4], ['MD', 4], ['TJ', 4], ['TM', 4],
  ['AE', 5], ['CN', 6],
] as const);

export function countryOptions(locale = 'ru', extra?: string) {
  const codes = extra ? [...countries, extra] : countries;
  const rank = (code: string) => countryPriority.get(code) ?? 7;
  const collator = new Intl.Collator(locale);
  return codes.map(value => ({ value, label: countryName(value, locale) }))
    .sort((a, b) => rank(a.value) - rank(b.value) || collator.compare(a.label, b.label));
}

export function formatMoney(value: number, currency: string, locale = 'ru') {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value); }
  catch { return value + ' ' + currency; }
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  shortName?: string;
  description?: string;
  icon?: string;
  active: boolean;
  count?: number;
  parentId?: string | null;
  attributeKeys?: string[];
  requiresModel?: boolean;
  translations?: Record<string, { name: string; shortName?: string; description?: string }>;
}

export function categoryName(category: Category, locale: string, short = false) {
  const translation = category.translations?.[locale];
  if (!short) return translation?.name || category.name;
  return translation?.shortName || translation?.name || category.shortName || category.name;
}

export interface ListingImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export interface Listing {
  id: string;
  title: string;
  description: string;
  kind: 'SELL' | 'BUY';
  categoryId: string;
  category?: Category;
  price: number | null;
  priceUsd?: number | null;
  totalPrice?: number | null;
  totalPriceUsd?: number | null;
  currency: string;
  priceMode: 'FIXED' | 'NEGOTIABLE';
  availability: string | null;
  condition: string | null;
  originCountry: string | null;
  stockCity: string | null;
  destinationCountry: string | null;
  originScope: string | null;
  deliveryBy: string | null;
  quantity: number;
  deliveryIncluded: boolean;
  customsIncluded: boolean;
  vat: string;
  counterparty: string;
  paymentMethods: string[];
  specs: Record<string, string>;
  owner: { id?: string; nickname?: string; displayName?: string; city: string | null; country: string; accountType?: string; participantType?: string; rating: number | null; ratingCount: number };
  status: string;
  createdByStaff?: string | null;
  ownerConfirmedAt?: string | null;
  reviewReasons?: string[];
  reviewReturnNote?: string | null;
  imageKey?: string | null;
  images?: ListingImage[];
  createdAt: string;
  lifetimeDays?: number;
  minLot?: number;
  shipDays?: number | null;
  paymentTerms?: string[];
  modelId?: string | null;
  requiresModel?: boolean;
  model?: { id: string; nameRu: string; status: string } | null;
  analogModelIds?: string[];
  representation?: 'DIRECT' | 'AGENT' | null;
  principalId?: string | null;
  agentFeeDisclosed?: boolean | null;
  agentFeeKind?: 'PERCENT' | 'PER_UNIT' | null;
  agentFeeValue?: number | null;
  agentFeePayer?: 'BUYER' | 'SELLER' | 'BOTH' | null;
  labels?: { id: string; text: string; tone?: string }[];
  confirmedAt?: string | null;
  expiresAt?: string | null;
  freshness?: { label: string; today: boolean; hoursAgo: number } | null;
  priceChanges14?: number;
  trust?: import('./Trust').ListingTrust | null;
  hiddenByRatingBelow?: number | null;
  lotGroup?: { id: string; participants: number; primary: boolean; collapsedCount: number } | null;
  similarLot?: boolean;
  isDuplicate?: boolean;
  duplicateAppealed?: boolean;
}

export const maxUnitPrice = 999_999_999.99;

export const categoryIcons: Record<string, string> = {
  gpu: 'gpu', servers: 'server', cpu: 'cpu', memory: 'memory-stick', storage: 'hard-drive',
  network: 'network', racks: 'panels-top-left', power: 'zap', cooling: 'fan', components: 'circuit-board',
};

export function categoryIcon(category: Category) {
  const key = category.icon ?? category.slug;
  return Object.hasOwn(categoryIcons, key) ? categoryIcons[key] : 'layers';
}

export const terms: Record<string, string> = {
  COMPANY: 'Компания', INDIVIDUAL: 'Частное лицо',
  STOCK: 'В наличии', TRANSIT: 'В пути', ORDER: 'Под заказ',
  NEW: 'Новое', USED: 'Б/у', REFURBISHED: 'Восстановленное',
  INCLUDED: 'Включён', EXCLUDED: 'Сверх указанной суммы', NA: 'Не применяется',
  DOMESTIC: 'Внутри страны', ANY: 'Любая', COUNTRY: 'Конкретная страна',
  BANK_TRANSFER: 'Банковский перевод', CARD: 'Банковская карта', CASH: 'Наличные',
  LETTER_OF_CREDIT: 'Аккредитив', ESCROW: 'Эскроу',
};

export const reportReasonNames = { FRAUD: 'Подозрение на мошенничество', ABUSE: 'Оскорбления, угрозы или спам', OTHER: 'Другая причина' };
