import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RouteTarget } from '../src/catalog.ts'
import { decide, type RouteLookup } from '../src/decide.ts'
import { ProviderHealth } from '../src/health.ts'
import type { RouteEndpoint, RouteRule } from '../src/rules.ts'
import { stickyFromTarget } from '../src/sticky.ts'

/** A catalog that honors the routes a test names, and rejects images for text-only ones. */
function lookup(textOnly: readonly string[] = []): RouteLookup {
  const has = (provider: string, model: string) => provider !== 'missing' && model !== 'missing'
  return {
    has,
    resolveEndpoint(endpoint: RouteEndpoint, needsImage: boolean): RouteTarget | undefined {
      if (!has(endpoint.provider, endpoint.model)) return undefined
      if (needsImage && textOnly.includes(endpoint.provider)) return undefined
      return { provider: endpoint.provider, model: endpoint.model }
    },
    acceptsImage: (provider: string) => !textOnly.includes(provider),
  }
}

/** One rule with the fields a test names. */
function rule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    name: 'rule',
    keywords: ['task'],
    hasImage: undefined,
    provider: 'p1',
    model: 'm1',
    reasoningEffort: undefined,
    ...overrides,
  }
}

const signals = { text: 'a task', hasImage: false }

describe('model-router decision', () => {
  it('returns no selection when nothing matches', () => {
    const decision = decide({
      rules: [rule({ keywords: ['other'] })],
      signals,
      classification: undefined,
      tierRoutes: {},
      sticky: undefined,
      stickinessEnabled: false,
      upgradeSteps: 1,
      health: new ProviderHealth(() => ({ failureThreshold: 2, cooldownMs: 1_000 })),
      catalog: lookup(),
      current: undefined,
    })
    expect(decision.kind).toBe('unchanged')
  })

  it('keeps a held route when the agent has since moved', () => {
    const sticky = stickyFromTarget(
      { provider: 'p1', model: 'm1', reasoningEffort: ReasoningEffortId('max') },
      'simple',
      true,
      'rule',
    )
    const kept = decide({
      rules: [rule()],
      signals: { ...signals, tier: 'simple' },
      classification: { tier: 'simple', scores: { simple: 3, standard: 0, hard: 0 }, reasons: [] },
      tierRoutes: {},
      sticky,
      stickinessEnabled: true,
      upgradeSteps: 1,
      health: new ProviderHealth(() => ({ failureThreshold: 2, cooldownMs: 1_000 })),
      catalog: lookup(),
      current: { provider: 'p2', model: 'm2' },
    })
    expect(kept.kind).toBe('select')
    expect(kept.logs.some(line => line.message.includes('keeping'))).toBe(true)
    expect(kept.logs.some(line => line.args.includes('no signals'))).toBe(true)
  })

  it('uses the held route as the half-open probe', () => {
    let now = 0
    const health = new ProviderHealth(() => ({
      failureThreshold: 1, cooldownMs: 1_000, mode: 'scored', jitterRatio: 0, probeLimit: 2,
    }), () => now, () => 0.5)
    health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })
    now = 1_000
    const sticky = stickyFromTarget({ provider: 'p1', model: 'm1' }, 'simple', true, 'rule')
    const probed = decide({
      rules: [rule()],
      signals: { ...signals, tier: 'simple' },
      classification: undefined,
      tierRoutes: {},
      sticky,
      stickinessEnabled: true,
      upgradeSteps: 1,
      health,
      catalog: lookup(),
      current: { provider: 'p1', model: 'm1' },
    })
    expect(probed.kind).toBe('unchanged')
    expect(health.availability('p1').kind).toBe('probe')
  })

  it('logs a break when the replacement is a different route and stays quiet when it is the same', () => {
    const health = new ProviderHealth(() => ({ failureThreshold: 2, cooldownMs: 1_000 }))
    const sticky = stickyFromTarget({ provider: 'p1', model: 'm1' }, 'simple', false, 'rule')
    const switched = decide({
      rules: [rule({ name: 'hard', tier: 'hard', provider: 'p2', model: 'm2', keywords: [] })],
      signals: { text: 'task', hasImage: true, tier: 'hard' },
      classification: { tier: 'hard', scores: { simple: 0, standard: 0, hard: 4 }, reasons: ['hint-hard'] },
      tierRoutes: {},
      sticky,
      stickinessEnabled: true,
      upgradeSteps: 1,
      health,
      catalog: lookup(['p1']),
      current: { provider: 'p1', model: 'm1' },
    })
    expect(switched.kind).toBe('select')
    if (switched.kind === 'select') expect(switched.target.provider).toBe('p2')
    expect(switched.logs.some(line => line.message.includes('leaving'))).toBe(true)
    const same = decide({
      rules: [rule({ tier: 'hard', keywords: [] })],
      signals: { ...signals, tier: 'hard' },
      classification: undefined,
      tierRoutes: {},
      sticky,
      stickinessEnabled: true,
      upgradeSteps: 1,
      health,
      catalog: lookup(),
      current: { provider: 'p1', model: 'm1' },
    })
    expect(same.logs.some(line => line.message.includes('leaving'))).toBe(false)
  })

  it('skips a route the catalog cannot honor and prefers the healthier duplicate', () => {
    const now = 0
    const health = new ProviderHealth(() => ({
      failureThreshold: 2, cooldownMs: 1_000, mode: 'scored', jitterRatio: 0, latencyBudgetMs: 100,
    }), () => now, () => 0.5)
    health.recordSuccess('p1', { latencyMs: 100, ttftMs: 100 })
    const decision = decide({
      rules: [
        rule({ name: 'missing', provider: 'missing', model: 'm1' }),
        rule({ name: 'blind', provider: 'p1', model: 'm1' }),
        rule({ name: 'again', provider: 'p2', model: 'm2', routes: [
          { provider: 'p2', model: 'm2', reasoningEffort: undefined },
          { provider: 'p1', model: 'm1', reasoningEffort: undefined },
        ] }),
      ],
      signals: { ...signals, hasImage: true },
      classification: { tier: 'standard', scores: { simple: 0, standard: 1, hard: 0 }, reasons: ['image'] },
      tierRoutes: { standard: [{ provider: 'p2', model: 'm2', reasoningEffort: undefined }] },
      sticky: undefined,
      stickinessEnabled: true,
      upgradeSteps: 1,
      health,
      catalog: lookup(),
      current: undefined,
    })
    expect(decision.kind).toBe('select')
    if (decision.kind === 'select') expect(decision.target).toEqual({ provider: 'p2', model: 'm2' })
    expect(decision.logs.some(line => line.level === 'debug' && String(line.args[0]).includes('missing'))).toBe(true)
  })

  it('probes the only candidate that is half-open', () => {
    let now = 0
    const health = new ProviderHealth(() => ({
      failureThreshold: 1, cooldownMs: 1_000, mode: 'scored', jitterRatio: 0,
    }), () => now, () => 0.5)
    health.recordFailure('p1', { code: 'TIMEOUT', message: 'slow' })
    now = 1_000
    const decision = decide({
      rules: [rule()],
      signals,
      classification: undefined,
      tierRoutes: {},
      sticky: undefined,
      stickinessEnabled: false,
      upgradeSteps: 1,
      health,
      catalog: lookup(),
      current: undefined,
    })
    expect(decision.kind).toBe('select')
    expect(health.availability('p1').kind).toBe('skip')
  })

  it('drops stickiness when the held route is gone and nothing else matches', () => {
    const health = new ProviderHealth(() => ({ failureThreshold: 2, cooldownMs: 1_000 }))
    const decision = decide({
      rules: [],
      signals,
      classification: undefined,
      tierRoutes: {},
      sticky: stickyFromTarget({ provider: 'missing', model: 'm1' }, undefined, true, 'old'),
      stickinessEnabled: true,
      upgradeSteps: 1,
      health,
      catalog: lookup(),
      current: undefined,
    })
    expect(decision.kind).toBe('unchanged')
    expect(decision.sticky).toBeUndefined()
    expect(decision.logs.some(line => line.message.includes('leaving'))).toBe(true)
  })
})
