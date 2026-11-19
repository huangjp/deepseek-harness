import { describe, expect, it } from 'vitest'
import { applyRemainingPenalty, RouteSpend, type RoutePrice } from '../src/spend.ts'

const PRICE: RoutePrice = {
  provider: 'p1',
  model: 'm1',
  inputPerMillion: 1,
  outputPerMillion: 2,
  dailyBudget: 0.000001,
  monthlyBudget: 1,
}

describe('model-router spend', () => {
  it('bills tokens and trips a daily budget', () => {
    let now = 1_000
    const spend = new RouteSpend(() => [PRICE], () => now)
    expect(spend.budgetExceeded('p1', 'm1')).toBe(false)
    spend.record('p1', 'm1', 2_000_000, 0)
    expect(spend.budgetExceeded('p1', 'm1')).toBe(true)
    expect(spend.estimate('p1', 'm1')).toEqual({ cost: 2, currency: 'USD' })
    expect(spend.snapshot('absent', 'm1').monthly).toBe(0)
    now += 25 * 60 * 60 * 1000
    expect(spend.snapshot('p1', 'm1').daily).toBe(0)
    expect(spend.snapshot('p1', 'm1').monthly).toBe(2)
    expect(spend.budgetExceeded('p1', 'm1')).toBe(true)
    now += 40 * 24 * 60 * 60 * 1000
    expect(spend.snapshot('p1', 'm1').monthly).toBe(0)
    expect(spend.all()).toHaveLength(1)
  })

  it('lowers a score as remaining quota falls and ignores an unpriced route', () => {
    const spend = new RouteSpend(() => [])
    spend.record('p1', 'm1', 10, 10)
    spend.noteRemaining('p1', Number.NaN)
    spend.noteRemaining('p1', 0.1)
    expect(spend.remainingRatio('p1')).toBe(0.1)
    expect(applyRemainingPenalty(1, undefined, 0.2)).toBe(1)
    expect(applyRemainingPenalty(1, 0.5, 0.2)).toBe(1)
    expect(applyRemainingPenalty(1, 0.1, 0.2)).toBe(0.5)
    expect(applyRemainingPenalty(1, 0, 0.2)).toBe(0)
    expect(applyRemainingPenalty(1, 0.1, 0)).toBe(1)
    expect(spend.budgetExceeded('p1', 'm1')).toBe(false)
    expect(spend.estimate('p1', 'm1')).toBeUndefined()
  })
})
