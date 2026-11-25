import assert from 'node:assert/strict'
import test from 'node:test'
import { countEligibleDeals, listingLimit, participantRating } from '../dist/exchange/trust-score.js'

const direct = { level: 1, deals: 0, ageDays: 35, ageMonths: 1, onTime: 10, totalAnswers: 10,
  speedHours: 3, direct: true, principalsConfirmed: false, lostDisputes: 0,
  agentFee: 'NONE', penalties: 0, banned: false }

test('trust rating example, eligibility, and all publication thresholds', () => {
  const rating = participantRating(direct)
  assert.equal(rating.total, 63)
  assert.deepEqual(rating.factors.map(item => item.value), [15, 0, 15, 7, 10, 10, 5, 1])
  const agent = { ...direct, level: 2, deals: 5, ageMonths: 7, speedHours: 1, direct: false,
    principalsConfirmed: true, agentFee: 'CONFIRMED' }
  assert.equal(participantRating(agent).total, 96)
  assert.equal(participantRating({ ...agent, lostDisputes: 1, agentFee: 'DISCLOSED' }).total, 88)
  assert.equal(participantRating({ ...agent, banned: true }).total, 0)
  assert.deepEqual([listingLimit(0, null), listingLimit(1, 79), listingLimit(1, 80), listingLimit(2, 0)], [3, 15, null, null])
  assert.equal(countEligibleDeals([
    { counterparty: 'a', verified_at: new Date('2025-01-01') },
    { counterparty: 'a', verified_at: new Date('2025-02-01') },
    { counterparty: 'b', verified_at: new Date('2025-02-10') },
    { counterparty: 'a', verified_at: new Date('2025-04-01') },
  ]), 3)
})
