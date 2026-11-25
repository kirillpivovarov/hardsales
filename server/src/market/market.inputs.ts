import { BadRequestException } from '@nestjs/common'
import { isISO31661Alpha2 } from 'class-validator'
import { outsideContact } from '../contact'

export const kinds = ['SELL', 'BUY'] as const
export const accountTypes = ['INDIVIDUAL', 'COMPANY'] as const
export const listingStatuses = ['ACTIVE', 'FROZEN', 'BANNED', 'ARCHIVED', 'HIDDEN'] as const
export const accountStatuses = ['ACTIVE', 'FROZEN', 'BANNED'] as const
export const reviewStatuses = ['ACTIVE', 'HIDDEN', 'BANNED'] as const
export const reportStatuses = ['OPEN', 'RESOLVED', 'REJECTED'] as const
export const currencies = ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'AED'] as const
export const conditions = ['NEW', 'USED', 'REFURBISHED', 'ANY'] as const
export const availability = ['STOCK', 'TRANSIT', 'ORDER'] as const
export const originScopes = ['DOMESTIC', 'ANY', 'COUNTRY'] as const
const sellerOriginScopes = ['ANY', 'COUNTRY'] as const
export const paymentMethods = ['BANK_TRANSFER', 'CARD', 'CASH', 'LETTER_OF_CREDIT'] as const
export const vatModes = ['INCLUDED', 'EXCLUDED', 'NA'] as const
export const counterparties = ['COMPANY', 'ANY'] as const

export function object(value: unknown, label = 'Данные'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label}: ожидается объект`)
  }
  return value as Record<string, unknown>
}

export function str(value: unknown, label: string, min: number, max: number): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (result.length < min || result.length > max || (typeof value !== 'string' && min === 0) || result.includes('\u0000')) {
    throw new BadRequestException(`${label}: от ${min} до ${max} символов`)
  }
  return result
}

export function oneOf<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new BadRequestException(`${label}: недопустимое значение`)
  }
  return value as T[number]
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) {
    throw new BadRequestException(`${label}: ожидается целое число от ${min} до ${max}`)
  }
  return result
}

export function boolean(value: unknown, label: string): boolean {
  if (value === 'true' || value === true) return true
  if (value === 'false' || value === false) return false
  throw new BadRequestException(`${label}: ожидается логическое значение`)
}

export function priceValue(value: unknown, label: string, minimum = 0.01): number {
  const result = typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value) ? Number(value) : value
  if (typeof result !== 'number' || !Number.isFinite(result) || result < minimum || result > 9999999999999.99 || !/^\d+(\.\d{1,2})?$/.test(String(result))) {
    throw new BadRequestException(`${label}: укажите корректную сумму с точностью до сотых`)
  }
  return result
}

export function uuid(value: unknown, label = 'Идентификатор'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${label}: неверный формат`)
  }
  return value.toLowerCase()
}

export function localeCode(value: unknown): string {
  const code = str(value, 'Язык', 2, 35)
  try {
    return Intl.getCanonicalLocales(code)[0].toLowerCase()
  } catch {
    throw new BadRequestException('Неверный код языка')
  }
}

export function slug(value: unknown, label: string): string {
  const result = str(value, label, 2, 48)
  if (!/^[a-z][a-z0-9-]+$/.test(result)) throw new BadRequestException(`${label}: используйте латиницу, цифры и дефисы`)
  return result
}

export function country(value: unknown, label: string): string {
  const result = str(value, label, 2, 2).toUpperCase()
  if (!isISO31661Alpha2(result)) throw new BadRequestException(`${label}: укажите двухбуквенный код страны`)
  return result
}

export function calendarDate(value: unknown, label: string): string {
  const result = str(value, label, 10, 10)
  const parsed = new Date(result)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result || result < '1900-01-01') {
    throw new BadRequestException(`${label}: укажите действительную дату`)
  }
  return result
}

export function telegram(value: unknown): string {
  const name = str(value, 'Telegram', 5, 33).replace(/^@/, '').toLowerCase()
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(name)) throw new BadRequestException('Укажите действительный ник Telegram')
  return name
}

export function pageParams(query: Record<string, unknown>, defaultLimit = 20) {
  const page = query.page === undefined ? 1 : integer(query.page, 'Страница', 1, 10000)
  const limit = query.limit === undefined ? defaultLimit : integer(query.limit, 'Размер страницы', 1, 100)
  return { page, limit, offset: (page - 1) * limit }
}

export class Parameters {
  readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

export function escapedSearch(value: unknown): string {
  const keyword = str(value, 'Поиск', 0, 200)
  return `%${keyword.replace(/[\\%_]/g, '\\$&')}%`
}

export function listingInput(body: unknown, existing: Record<string, unknown>, kind: typeof kinds[number]) {
  const patch = object(body)
  const input = { ...existing, ...patch }
  const title = str(input.title, 'Название', 3, 140)
  const description = str(input.description, 'Описание', 10, 8000)
  if ([title, description].some(outsideContact)) {
    throw new BadRequestException('Уберите контакты и ссылки из объявления. Связаться можно в чате площадки.')
  }
  const categoryId = uuid(input.categoryId, 'Категория')
  const quantity = integer(input.quantity ?? 1, 'Количество', 1, 1000000)
  const condition = oneOf(input.condition ?? (kind === 'SELL' ? 'NEW' : 'ANY'), conditions, 'Состояние')
  if (kind === 'SELL' && condition === 'ANY') throw new BadRequestException('Укажите состояние оборудования')
  const priceMode = oneOf(input.priceMode ?? 'NEGOTIABLE', ['FIXED', 'NEGOTIABLE'], 'Тип цены')
  const price = priceMode === 'FIXED' ? priceValue(input.price, 'Цена') : null
  const currency = oneOf(input.currency ?? 'RUB', currencies, 'Валюта')
  const destinationCountry = kind === 'BUY' || input.destinationCountry
    ? country(input.destinationCountry, 'Страна доставки')
    : null
  const sellerSource = patch.originScope === undefined && patch.originCountry != null
    ? 'COUNTRY'
    : input.originScope ?? 'COUNTRY'
  const source = kind === 'BUY'
    ? oneOf(input.originScope ?? 'ANY', originScopes, 'География поставки')
    : oneOf(sellerSource, sellerOriginScopes, 'География отгрузки')
  if (kind === 'SELL' && source === 'ANY' && patch.originCountry != null) {
    throw new BadRequestException('Для отгрузки из любой страны уберите конкретную страну')
  }
  const originCountry = source === 'DOMESTIC' ? destinationCountry
    : source === 'ANY' ? null
    : country(input.originCountry, 'Страна отгрузки')
  const stock = kind === 'SELL' ? oneOf(input.availability ?? 'STOCK', availability, 'Наличие') : null
  const stockCity = stock === 'STOCK' ? str(input.stockCity, 'Город склада', 2, 120) : null
  const dateLabel = kind === 'BUY' ? 'Срок поставки' : 'Срок действия предложения'
  const deliveryBy = kind === 'BUY' || input.deliveryBy ? calendarDate(input.deliveryBy, dateLabel) : null
  if (deliveryBy && deliveryBy !== existing.deliveryBy && deliveryBy < new Date().toISOString().slice(0, 10)) {
    throw new BadRequestException(`${dateLabel} не может быть в прошлом`)
  }
  const deliveryIncluded = boolean(input.deliveryIncluded ?? false, 'Доставка')
  const customsIncluded = boolean(input.customsIncluded ?? false, 'Таможенные расходы')
  const vat = oneOf(input.vat ?? 'NA', vatModes, 'НДС')
  const counterparty = oneOf(input.counterparty ?? 'ANY', counterparties, 'Тип контрагента')
  const methods = input.paymentMethods ?? ['BANK_TRANSFER']
  if (!Array.isArray(methods) || !methods.length || methods.length > paymentMethods.length) {
    throw new BadRequestException('Выберите один или несколько способов оплаты')
  }
  const validMethods = [...new Set(methods.map(item => oneOf(item, paymentMethods, 'Способ оплаты')))]
  const rawSpecs = Object.entries(object(input.specs ?? {}, 'Характеристики'))
  if (rawSpecs.length > 30) throw new BadRequestException('Можно указать до 30 характеристик')
  const specs = Object.fromEntries(rawSpecs.map(([key, value]) => [str(key, 'Название характеристики', 1, 80), str(value, 'Характеристика', 1, 300)]))
  if ([stockCity ?? '', ...Object.keys(specs), ...Object.values(specs)].some(outsideContact)) {
    throw new BadRequestException('Уберите контакты из характеристик и города склада')
  }

  return [
    categoryId, title, description, quantity, condition, priceMode, price, currency, stock,
    source, originCountry, destinationCountry, stockCity, deliveryBy, deliveryIncluded, customsIncluded,
    vat, counterparty, validMethods, JSON.stringify(specs),
  ]
}
