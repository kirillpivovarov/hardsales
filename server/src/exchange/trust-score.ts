import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function seed<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, '../../seeds/exchange_data', name), 'utf8')) as T
}

type RatingWeights = {
  participant: {
    factors: {
      id: string; label_ru: string; max: number
      points_by_level?: Record<string, number>
      steps?: { min_deals?: number; max_hours?: number | null; points: number }[]
    }[]
    reliable_threshold: number
  }
}

export const paymentForms = seed<{
  payment_terms: {
    code: string; label_ru: string; when_ru: string; seller_risk_ru: string; buyer_risk_ru: string; hint_ru: string
  }[]
}>('payment_forms.json')
export const paymentCompatibility = seed<{ rules: unknown[]; fallback: unknown }>('payment_compatibility.json')

const weights = seed<RatingWeights>('rating_weights.json').participant
const factor = (id: string) => weights.factors.find(item => item.id === id)!
export const levelNames = ['не проверен', 'проверен документами', 'проверен сделкой'] as const
export const reliableThreshold = weights.reliable_threshold
const day = 86_400_000

export type ParticipantRatingInput = {
  level: number
  deals: number
  ageDays: number
  ageMonths: number
  onTime: number
  totalAnswers: number
  speedHours: number | null
  direct: boolean
  principalsConfirmed: boolean
  lostDisputes: number
  agentFee: 'CONFIRMED' | 'DISCLOSED' | 'NONE'
  penalties: number
  banned: boolean
}

export type RatingFactor = { id: string; name: string; max: number; value: number; detail: string; hint: string }

export function participantRating(input: ParticipantRatingInput) {
  const values: Record<string, number> = {
    level: factor('level').points_by_level?.[input.level] ?? 0,
    deals: factor('deals').steps?.find(step => input.deals >= (step.min_deals ?? 0))?.points ?? 0,
    discipline: input.ageDays < 7 ? 10 : input.totalAnswers ? Math.round(input.onTime * 150 / input.totalAnswers) / 10 : 15,
    speed: input.speedHours === null ? 0 : factor('speed').steps?.find(step => step.max_hours == null || input.speedHours! <= step.max_hours)?.points ?? 0,
    direct: input.direct ? 10 : input.principalsConfirmed ? 6 : 2,
    disputes: Math.max(0, 10 - input.lostDisputes * 5),
    fees: input.direct || input.agentFee === 'CONFIRMED' ? 5 : input.agentFee === 'DISCLOSED' ? 2 : 0,
    tenure: Math.max(0, Math.min(5, input.ageMonths)),
  }
  const description: Record<string, [string, string]> = {
    level: [levelNames[input.level] ?? levelNames[0], 'Подтвердите документы или исполненную сделку.'],
    deals: [`Засчитано сделок: ${input.deals}`, 'Пройдите проверку документов по исполненной сделке.'],
    discipline: [input.ageDays < 7 ? 'Первые семь дней на площадке' : `В срок: ${input.onTime} из ${input.totalAnswers}`, 'Отвечайте на вопросы об актуальности до срока.'],
    speed: [input.speedHours === null ? 'Нет данных' : `Медиана: ${Math.round(input.speedHours * 10) / 10} ч`, 'Быстрее отвечайте на подходящие совпадения.'],
    direct: [input.direct ? 'Прямой участник' : input.principalsConfirmed ? 'Принципалы подтверждены' : 'Принципалы ожидают подтверждения', 'Получите подтверждение от принципалов.'],
    disputes: [`Проигранных споров: ${input.lostDisputes}`, 'Следите за достоверностью объявлений и условиями сделки.'],
    fees: [input.direct ? 'Прямой участник' : input.agentFee === 'CONFIRMED' ? 'Вознаграждение подтверждено' : input.agentFee === 'DISCLOSED' ? 'Вознаграждение раскрыто' : 'Вознаграждение не подтверждено', 'Раскройте агентское вознаграждение и подтвердите его.'],
    tenure: [`Полных месяцев: ${input.ageMonths}`, 'Баллы увеличиваются по мере работы на площадке.'],
  }
  const factors: RatingFactor[] = weights.factors.map(({ id, label_ru, max }) => ({
    id, name: label_ru, max, value: values[id], detail: description[id][0], hint: values[id] < max ? description[id][1] : '',
  }))
  const sum = factors.reduce((total, entry) => total + entry.value, 0) - input.penalties
  const total = input.banned ? 0 : Math.max(0, Math.min(100, Math.round(sum)))
  return { total, factors, reliable: total >= reliableThreshold }
}

export function listingLimit(level: number, score: number | null) {
  if (level === 2 || Number(score) >= reliableThreshold) return null
  return level === 1 ? 15 : 3
}

/** A suppressed deal cannot reset the window for the next eligible deal. */
export function dealRatingEligibility<T extends { counterparty: string; verified_at: Date }>(deals: T[]) {
  const lastCounted = new Map<string, number>()
  return deals.map(deal => {
    const { counterparty, verified_at } = deal
    const time = verified_at.getTime()
    const previous = lastCounted.get(counterparty)
    if (previous !== undefined && time - previous < 90 * day) {
      return { deal, nextEligibleAt: new Date(previous + 90 * day) }
    }
    lastCounted.set(counterparty, time)
    return { deal, nextEligibleAt: null }
  })
}

export function countEligibleDeals(deals: { counterparty: string; verified_at: Date }[]) {
  return dealRatingEligibility(deals).filter(({ nextEligibleAt }) => nextEligibleAt === null).length
}
