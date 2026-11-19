import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, type Config, type RuleConfig } from '@deepseek-ai/dsh-model-router'
import { FOURSAPI_PROVIDER } from '../src/catalog.ts'
import * as Foursapi from '../src/index.ts'

afterEach(() => { vi.unstubAllEnvs() })

function volatile<T>(value: T): { get: () => T } {
  return { get: () => value }
}

function routerConfig(rules: readonly RuleConfig[]): Config {
  return {
    enabled: volatile(true),
    rules: volatile(rules),
    failureThreshold: volatile(2),
    cooldownMs: volatile(300_000),
    classifier: volatile({
      enabled: false,
      promptCharsStandard: 1_200,
      promptCharsHard: 4_000,
      contextTokensStandard: 8_000,
      contextTokensHard: 32_000,
      toolUseStandard: 1,
      toolUseHard: 6,
      hardMark: 4,
      simpleMark: 3,
    }),
    stickiness: volatile({ enabled: false, upgradeSteps: 1 }),
    health: volatile({
      mode: 'consecutive',
      windowSize: 20,
      ewmaAlpha: 0.3,
      maxCooldownMs: 1_800_000,
      backoffFactor: 2,
      jitterRatio: 0,
      probeLimit: 1,
      latencyBudgetMs: 20_000,
      ttftBudgetMs: 4_000,
      weights: { timeout: 1, server: 1, network: 1, rateLimit: 0.5, unknown: 1 },
    }),
    tierRoutes: volatile({ simple: [], standard: [], hard: [] }),
    cost: volatile({ enabled: false, remainingThreshold: 0.2 }),
    pricing: volatile([]),
    fallback: volatile({ enabled: true, maxHops: 1 }),
  }
}

const rule: RuleConfig = {
  name: 'relay',
  keywords: ['relay'],
  provider: FOURSAPI_PROVIDER,
  model: 'demo-model',
}

function claim(ctx: Context): string[] {
  const selected: string[] = []
  const agent = {
    model: {
      current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      select: (target: { provider: string; model: string }) => {
        selected.push(`${target.provider}/${target.model}`)
      },
      routingMode: () => 'auto' as const,
    },
    session: { snapshotEvents: () => [], append: () => undefined },
  } as Agent
  agentEvents(ctx, agent).emit('agent/inbox/claimed', {
    message: createUserMessage({
      content: [{ type: 'text', text: 'please relay this' }],
      source: { kind: 'user' },
    }),
    turn: 1,
  })
  return selected
}

it('skips the route until a key exists, then selects the listed model', async () => {
  const absent = new Context()
  await absent.plugin(LlmRuntime)
  await absent.plugin(Foursapi, {
    models: [{ id: 'demo-model' }],
    usePricingEndpoint: false,
  })
  await apply(absent, routerConfig([rule]))
  expect(claim(absent)).toEqual([])
  await absent.fiber.dispose()

  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  const present = new Context()
  await present.plugin(LlmRuntime)
  await present.plugin(Foursapi, {
    models: [{ id: 'demo-model' }],
    usePricingEndpoint: false,
  })
  await apply(present, routerConfig([rule]))
  expect(claim(present)).toEqual([`${FOURSAPI_PROVIDER}/demo-model`])
  await present.fiber.dispose()
})
