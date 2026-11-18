import { describe, expect, it } from 'vitest'
import { Config, type Config as RouterConfig } from '../src/index.ts'

/** The schema's public type is the resolved config, so the test passes the raw document through a widened call. */
function load(input: object): RouterConfig {
  const schema: (value: object) => RouterConfig = Config as (value: object) => RouterConfig
  return schema(input)
}

describe('model-router config', () => {
  it('keeps an old rule table and fills the new sections from their defaults', () => {
    const config = load({
      enabled: true,
      rules: [{ name: 'writing', keywords: ['小说'], provider: 'p1', model: 'm1' }],
      failureThreshold: 2,
      cooldownMs: 300_000,
    })
    expect(config.enabled.get()).toBe(true)
    expect(config.rules.get()).toEqual([
      { name: 'writing', keywords: ['小说'], provider: 'p1', model: 'm1', routes: [] },
    ])
    expect(config.failureThreshold.get()).toBe(2)
    expect(config.cooldownMs.get()).toBe(300_000)
    expect(config.classifier.get().enabled).toBe(true)
    expect(config.classifier.get().hardKeywords).toEqual([])
    expect(config.stickiness.get()).toEqual({ enabled: false, upgradeSteps: 1 })
    expect(config.health.get().mode).toBe('consecutive')
    expect(config.health.get().weights.rateLimit).toBe(0.5)
    expect(config.tierRoutes.get()).toEqual({ simple: [], standard: [], hard: [] })
  })

  it('accepts a tier, a route list, and scored health', () => {
    const config = load({
      rules: [{
        name: 'hard',
        tier: 'hard',
        routes: [{ provider: 'p2', model: 'm2', reasoningEffort: 'max' }],
        provider: 'p2',
        model: 'm2',
      }],
      health: { mode: 'scored', weights: { rateLimit: 0.25 } },
      tierRoutes: { hard: [{ provider: 'p1', model: 'm1' }] },
      stickiness: { enabled: true, upgradeSteps: 2 },
    })
    expect(config.rules.get()[0]).toMatchObject({ tier: 'hard', provider: 'p2' })
    expect(config.health.get().mode).toBe('scored')
    expect(config.health.get().weights.rateLimit).toBe(0.25)
    expect(config.health.get().weights.timeout).toBe(1)
    expect(config.tierRoutes.get().hard).toEqual([{ provider: 'p1', model: 'm1' }])
    expect(config.stickiness.get().enabled).toBe(true)
  })
})
