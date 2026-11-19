import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { decide, ModelCatalog, ProviderHealth, signalsOf } from '@deepseek-ai/dsh-model-router'
import type { RouteRule } from '@deepseek-ai/dsh-model-router'
import { FOURSAPI_PROVIDER } from '../src/catalog.ts'
import * as Foursapi from '../src/index.ts'

afterEach(() => { vi.unstubAllEnvs() })

const rule: RouteRule = {
  name: 'relay',
  keywords: ['relay'],
  hasImage: undefined,
  provider: FOURSAPI_PROVIDER,
  model: 'demo-model',
  reasoningEffort: undefined,
}

function health(): ProviderHealth {
  return new ProviderHealth(() => ({
    failureThreshold: 2,
    cooldownMs: 300_000,
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
  }))
}

async function mount(key: string | undefined): Promise<Context> {
  if (key === undefined) vi.stubEnv('FOURSAPI_API_KEY', '')
  else vi.stubEnv('FOURSAPI_API_KEY', key)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Foursapi, {
    models: [{ id: 'demo-model' }],
    usePricingEndpoint: false,
  })
  return ctx
}

function decision(catalog: ModelCatalog, routeHealth: ProviderHealth) {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'please relay this' }],
    source: { kind: 'user' },
  })
  return decide({
    rules: [rule],
    signals: signalsOf(message),
    classification: undefined,
    tierRoutes: { simple: [], standard: [], hard: [] },
    sticky: undefined,
    stickinessEnabled: false,
    upgradeSteps: 1,
    health: routeHealth,
    catalog,
    current: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
}

it('skips the route until a key exists, then selects the listed model', async () => {
  const absent = await mount(undefined)
  const absentCatalog = new ModelCatalog(absent)
  await absentCatalog.refresh([rule])
  expect(absentCatalog.has(FOURSAPI_PROVIDER, 'demo-model')).toBe(false)
  expect(decision(absentCatalog, health()).kind).toBe('unchanged')
  await absent.fiber.dispose()

  const present = await mount('fixture-api-key')
  const presentCatalog = new ModelCatalog(present)
  await presentCatalog.refresh([rule])
  expect(presentCatalog.has(FOURSAPI_PROVIDER, 'demo-model')).toBe(true)
  const selected = decision(presentCatalog, health())
  expect(selected.kind).toBe('select')
  if (selected.kind === 'select') {
    expect(selected.target).toMatchObject({ provider: FOURSAPI_PROVIDER, model: 'demo-model' })
  }
  await present.fiber.dispose()
})
