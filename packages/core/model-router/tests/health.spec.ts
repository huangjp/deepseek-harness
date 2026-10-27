import { describe, expect, it } from 'vitest'
import { ProviderHealth, type HealthPolicy } from '../src/health.ts'

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

  it('reads the policy again so a live configuration change takes effect', () => {
    let threshold = 2
    const health = new ProviderHealth(() => ({ failureThreshold: threshold, cooldownMs: 60_000 }))
    expect(health.recordFailure('p1')).toBe(false)
    threshold = 1
    expect(health.recordFailure('p1')).toBe(true)
  })
})
