/**
 * The failure waterfall is dispatched on an agent-scoped carrier, so a
 * host-level plugin sees a failed request only when the scope filter admits
 * an untagged listener and the plugin listens ahead of the retry policy.
 * These tests run that dispatch for real over a live Cordis context, because
 * a stubbed context cannot show either fact.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, type Config, type RuleConfig } from '../src/index.ts'

/** An adapter that serves every route the rule table names. */
class StubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A live context carrying the provider registry the plugin reads. */
async function liveContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['p1', 'p2'], new StubAdapter())
  return ctx
}

/** The rule the task matches, and the one that catches everything else. */
const LONG_FORM: RuleConfig = {
  name: 'long-form',
  keywords: ['小说'],
  provider: 'p1',
  model: 'm1',
}

const FALLBACK: RuleConfig = {
  name: 'fallback',
  keywords: [],
  hasImage: false,
  provider: 'p2',
  model: 'm2',
}

/** A configuration the plugin reads through volatile references. */
function config(rules: readonly RuleConfig[]): Config {
  return {
    enabled: { get: () => true },
    rules: { get: () => rules },
    failureThreshold: { get: () => 2 },
    cooldownMs: { get: () => 300_000 },
  }
}

/** An agent whose model selection can be observed. */
function fakeAgent(current = { provider: 'p0', model: 'm0' }): { readonly agent: Agent; readonly selected: string[] } {
  const selected: string[] = []
  const agent = {
    id: 'agent-1',
    model: {
      current: () => current,
      select: (target: { provider: string; model: string }) => {
        selected.push(`${target.provider}/${target.model}`)
      },
    },
  } as unknown as Agent
  return { agent, selected }
}

/** The message the loop claims for a turn. */
function claimed(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: 'm1',
  } as unknown as UserMessage
}

/** Report one failed request the way the loop does. */
async function reportFailure(ctx: Context, agent: Agent): Promise<void> {
  const dispatch = agentEvents(ctx, agent)
  await dispatch.waterfall(
    'agent/request-error',
    {
      turn: 1,
      step: 1,
      provider: 'p1',
      failure: { message: 'connection refused', code: 'TRANSPORT' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    },
    () => Promise.resolve(undefined),
  )
}

describe('model-router failure dispatch', () => {
  it('counts a failure the agent-scoped waterfall reports to a host-level listener', async () => {
    const ctx = await liveContext()
    await apply(ctx, config([LONG_FORM, FALLBACK]))
    const { agent, selected } = fakeAgent()

    await reportFailure(ctx, agent)
    await reportFailure(ctx, agent)

    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: claimed('写一部小说'), turn: 1 })
    expect(selected).toEqual(['p2/m2'])
  })

  it('counts the failed attempt a retry policy would otherwise swallow', async () => {
    const ctx = await liveContext()
    await apply(ctx, config([LONG_FORM, FALLBACK]))
    const { agent, selected } = fakeAgent()
    // A retry policy registered after the router ends the chain without
    // delegating, exactly as the harness's own policy does.
    ctx.on('agent/request-error', () => ({ kind: 'retry' }) as never)

    await reportFailure(ctx, agent)
    await reportFailure(ctx, agent)

    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: claimed('写一部小说'), turn: 1 })
    expect(selected).toEqual(['p2/m2'])
  })

  it('keeps a route that has not failed enough', async () => {
    const ctx = await liveContext()
    await apply(ctx, config([LONG_FORM, FALLBACK]))
    const { agent, selected } = fakeAgent()

    await reportFailure(ctx, agent)

    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: claimed('写一部小说'), turn: 1 })
    expect(selected).toEqual(['p1/m1'])
  })
})
