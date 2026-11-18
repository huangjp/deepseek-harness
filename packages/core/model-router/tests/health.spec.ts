import { describe, expect, it } from 'vitest'
import { classifyRouteFailure, cooldownDelay, ProviderHealth, scoredPenalty, type HealthPolicy } from '../src/health.ts'

/** A policy that skips a route after the given number of consecutive failures. */
function policy(failureThreshold: number, cooldownMs = 60_000): () => HealthPolicy {
  return () => ({ failureThreshold, cooldownMs })
}

describe('model-router route health', () => {
  it('keeps a route eligible until it fails the configured number of times', () => {
    const health = new ProviderHealth(policy(2))
    expect(health.recordFailure('p1')).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
    expect(health.recordFailure('p1')).toBe(true)
    expect(health.isSkipped('p1')).toBe(true)
  })

  it('keeps every route eligible when the threshold is zero', () => {
    const health = new ProviderHealth(policy(0))
    expect(health.recordFailure('p1')).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('counts each route on its own', () => {
    const health = new ProviderHealth(policy(1))
    expect(health.recordFailure('p1')).toBe(true)
    expect(health.isSkipped('p2')).toBe(false)
  })

  it('makes a route eligible again once it answers', () => {
    const health = new ProviderHealth(policy(1))
    health.recordFailure('p1')
    expect(health.isSkipped('p1')).toBe(true)
    health.recordSuccess('p1')
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('makes a route eligible again when its cooldown expires', () => {
    let now = 1_000
    const health = new ProviderHealth(policy(1, 500), () => now)
    health.recordFailure('p1')
    expect(health.isSkipped('p1')).toBe(true)
    now = 1_500
    expect(health.isSkipped('p1')).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('skips a route again after a fresh failure once its cooldown expired', () => {
    let now = 1_000
    const health = new ProviderHealth(policy(1, 500), () => now)
    health.recordFailure('p1')
    now = 2_000
    expect(health.isSkipped('p1')).toBe(false)
    expect(health.recordFailure('p1')).toBe(true)
    expect(health.isSkipped('p1')).toBe(true)
  })

  it('does not let a later cooldown shorten a quota hold', () => {
    let now = 1_000
    const health = new ProviderHealth(policy(1, 500), () => now)
    health.hold('p1', 10_000)
    expect(health.recordFailure('p1')).toBe(true)
    now = 2_000
    expect(health.isSkipped('p1')).toBe(true)
    expect(health.availability('p1')).toEqual({ kind: 'skip', cause: 'held' })
    now = 10_000
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('keeps the later quota hold and reports an auth skip from isSkipped', () => {
    const health = new ProviderHealth(policy(1), () => 1_000)
    health.hold('p1', 10_000)
    health.hold('p1', 4_000)
    expect(health.inspect('p1').heldUntilMs).toBe(10_000)
    expect(health.inspect('absent').circuit).toBe('closed')
    health.noteConfigEpoch(2)
    health.recordFailure('p1', { code: 'AUTH', message: 'bad key' })
    health.noteConfigEpoch(1)
    expect(health.isSkipped('p1')).toBe(true)
    health.admit('p1')
    expect(health.score('absent')).toBe(1)
  })

  it('ignores a hold that is not a finite instant', () => {
    const health = new ProviderHealth(policy(1))
    health.hold('p1', Number.NaN)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('does not count a replenishing quota window', () => {
    const health = new ProviderHealth(policy(1))
    expect(health.recordFailure('p1', { code: 'QUOTA_WINDOW', message: 'window' })).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('marks an auth failure unusable until configuration changes', () => {
    const health = new ProviderHealth(policy(5))
    expect(health.recordFailure('p1', { code: 'AUTH', message: 'bad key' })).toBe(true)
    expect(health.availability('p1')).toEqual({ kind: 'skip', cause: 'unavailable' })
    health.noteConfigEpoch(1)
    expect(health.isSkipped('p1')).toBe(false)
    health.noteConfigEpoch(1)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('clears an auth mark when the route answers', () => {
    const health = new ProviderHealth(policy(1))
    health.recordFailure('p1', { status: 401, message: 'nope' })
    health.recordSuccess('p1')
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('reads the policy again so a live configuration change takes effect', () => {
    let threshold = 2
    const health = new ProviderHealth(() => ({ failureThreshold: threshold, cooldownMs: 60_000 }))
    expect(health.recordFailure('p1')).toBe(false)
    threshold = 1
    expect(health.recordFailure('p1')).toBe(true)
  })
})

/** Scored policy with jitter pinned so a delay equals the base. */
function scored(overrides: Partial<HealthPolicy> = {}): () => HealthPolicy {
  return () => ({
    failureThreshold: 2,
    cooldownMs: 1_000,
    mode: 'scored',
    jitterRatio: 0,
    maxCooldownMs: 8_000,
    probeLimit: 1,
    windowSize: 3,
    ...overrides,
  })
}

describe('model-router scored health', () => {
  it('opens after weighted failures and admits one probe when the cooldown ends', () => {
    let now = 5_000
    const health = new ProviderHealth(scored(), () => now, () => 0.5)
    expect(health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })).toBe(false)
    expect(health.recordFailure('p1', { code: 'SERVER', status: 500, message: 'down' })).toBe(true)
    expect(health.availability('p1')).toEqual({ kind: 'skip', cause: 'cooldown' })
    now = 6_000
    expect(health.availability('p1')).toEqual({ kind: 'probe' })
    health.admit('p1')
    expect(health.availability('p1')).toEqual({ kind: 'skip', cause: 'cooldown' })
    health.recordSuccess('p1', { latencyMs: 100, ttftMs: 20 })
    expect(health.availability('p1')).toEqual({ kind: 'open' })
    expect(health.score('p1')).toBeGreaterThan(0)
    expect(health.inspect('p1').circuit).toBe('closed')
  })

  it('backs off after a failed probe', () => {
    let now = 0
    const health = new ProviderHealth(scored(), () => now, () => 0.5)
    health.recordFailure('p1', { code: 'TRANSPORT', message: 'reset' })
    health.recordFailure('p1', { code: 'TRANSPORT', message: 'reset' })
    now = 1_000
    health.admit('p1')
    expect(health.recordFailure('p1', { code: 'TRANSPORT', message: 'reset' })).toBe(true)
    expect(health.inspect('p1').backoffStep).toBe(2)
    expect(health.inspect('p1').openUntilMs).toBe(3_000)
  })

  it('trips a short rate limit more slowly than a timeout, and a quota at once', () => {
    const health = new ProviderHealth(scored(), () => 0, () => 0.5)
    expect(health.recordFailure('p1', { status: 429, message: 'busy' })).toBe(false)
    expect(health.recordFailure('p1', { code: 'RATE_LIMIT', message: 'busy' })).toBe(false)
    expect(health.recordFailure('p1', { code: 'RATE_LIMIT', message: 'busy' })).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
    expect(health.recordFailure('p2', { code: 'QUOTA', message: 'empty' })).toBe(true)
    expect(health.isSkipped('p2')).toBe(true)
  })

  it('does not open a scored cooldown when the threshold is zero', () => {
    const health = new ProviderHealth(scored({ failureThreshold: 0 }))
    expect(health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })).toBe(false)
    expect(health.recordFailure('p1', { code: 'QUOTA', message: 'empty' })).toBe(false)
    expect(health.isSkipped('p1')).toBe(false)
  })

  it('scores a route from latency alone and caps a huge sample', () => {
    const health = new ProviderHealth(scored({ latencyBudgetMs: 100, ttftBudgetMs: 50 }), () => 0, () => 0.5)
    health.recordTiming('p1', { latencyMs: 10_000 })
    expect(health.score('p1')).toBeLessThan(1)
    health.recordTiming('p2', { ttftMs: 10 })
    expect(health.score('p2')).toBeLessThan(1)
  })

  it('lowers the score as latency grows and trims the window', () => {
    const health = new ProviderHealth(scored({ latencyBudgetMs: 100, ttftBudgetMs: 50, windowSize: 2 }), () => 0, () => 0.5)
    health.recordSuccess('p1', { latencyMs: 100, ttftMs: 50 })
    health.recordTiming('p1', { latencyMs: 100 })
    health.recordSuccess('p1')
    health.recordSuccess('p1')
    expect(health.inspect('p1').window).toHaveLength(2)
    expect(health.score('p1')).toBeLessThan(1)
    expect(health.score('absent')).toBe(1)
  })

  it('admits only the configured number of probes', () => {
    let now = 0
    const health = new ProviderHealth(scored({ probeLimit: 2 }), () => now, () => 0.5)
    health.recordFailure('p1', { code: 'UNKNOWN', message: 'x' })
    health.recordFailure('p1', { message: 'x' })
    now = 1_000
    health.admit('p1')
    expect(health.availability('p1').kind).toBe('probe')
    expect(health.availability('never').kind).toBe('open')
    health.admit('p1')
    health.admit('p1')
    expect(health.availability('p1').kind).toBe('skip')
    health.admit('absent')
  })

  it('classifies statuses and codes', () => {
    expect(classifyRouteFailure(undefined)).toBe('unknown')
    expect(classifyRouteFailure({ code: 'QUOTA_WINDOW' })).toBe('quota-window')
    expect(classifyRouteFailure({ code: 'ACCOUNT_QUOTA' })).toBe('quota')
    expect(classifyRouteFailure({ code: 'INVALID_CREDENTIAL' })).toBe('auth')
    expect(classifyRouteFailure({ status: 408 })).toBe('timeout')
    expect(classifyRouteFailure({ status: 504 })).toBe('timeout')
    expect(classifyRouteFailure({ status: 429 })).toBe('rate-limit')
    expect(classifyRouteFailure({ status: 502 })).toBe('server')
    expect(classifyRouteFailure({ status: 400 })).toBe('auth')
    expect(classifyRouteFailure({ code: 'TIMEOUT', status: 500 })).toBe('timeout')
    expect(scoredPenalty('auth', 2)).toBe(0)
    expect(scoredPenalty('quota-window', 2)).toBe(0)
    expect(scoredPenalty('quota', 2)).toBe(2)
    expect(scoredPenalty('rate-limit', 2, { rateLimit: 0.25 })).toBe(0.25)
  })

  it('uses built-in scored defaults and does not reopen a circuit that is already open', () => {
    let now = 0
    const health = new ProviderHealth(() => ({ failureThreshold: 2, cooldownMs: 1_000, mode: 'scored' }), () => now)
    expect(health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })).toBe(false)
    expect(health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })).toBe(true)
    expect(health.recordFailure('p1', { code: 'QUOTA', message: 'empty' })).toBe(true)
    expect(health.inspect('p1').circuit).toBe('open')
    health.recordTiming('p1', {})
    health.recordSuccess('p2', { ttftMs: 10 })
    now = health.inspect('p1').openUntilMs ?? 0
    health.admit('p1')
    expect(health.inspect('p1').circuit).toBe('half-open')
  })

  it('treats a zero probe limit as one probe', () => {
    let now = 0
    const health = new ProviderHealth(() => ({
      failureThreshold: 1, cooldownMs: 100, mode: 'scored', jitterRatio: 0, probeLimit: 0,
    }), () => now, () => 0.5)
    health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })
    now = 100
    health.admit('p1')
    expect(health.availability('p1').kind).toBe('skip')
  })

  it('applies jitter around the exponential cooldown', () => {
    expect(cooldownDelay(1_000, 0, 2, 8_000, 0.1, 0.5)).toBe(1_000)
    expect(cooldownDelay(1_000, 1, 2, 8_000, 0, 0)).toBe(2_000)
    expect(cooldownDelay(1_000, 5, 2, 3_000, 0, 1)).toBe(3_000)
    expect(cooldownDelay(1_000, 0, 2, 8_000, 1, 0)).toBe(0)
  })
})
