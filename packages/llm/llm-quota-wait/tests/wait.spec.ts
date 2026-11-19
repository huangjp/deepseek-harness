/**
 * A quota window holds the open step and then retries it. A short rate limit
 * does not enter that wait. Cancelling the turn ends the wait, and a tool
 * result recorded before the window stays in the same turn.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage, LlmError, QUOTA_WINDOW_CODE, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import * as quota from '../src/index.ts'
import type { QuotaWaitInternals } from '../src/index.ts'
import { QUOTA_PROBE_INITIAL_MS, QUOTA_RESET_GRACE_MS } from '../src/schedule.ts'

type ScriptEntry = Error | StreamChunk[]

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('quota wait test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(policies: Readonly<Record<string, RetryPolicyConfig | undefined>>): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined ? undefined : resolveRetryPolicy(policy, `quota wait test "${provider}"`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function quotaError(message: string): LlmError {
  return new LlmError(message, QUOTA_WINDOW_CODE, { status: 429 })
}

const NOW = 1_700_000_000_000

async function harness(options: {
  adapter: ScriptedAdapter
  internals?: QuotaWaitInternals
  withRetry?: boolean
  beforeQuota?: (ctx: Context) => void
  beforeLoop?: (ctx: Context) => void
}): Promise<{ ctx: Context; quotaFiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  options.beforeQuota?.(ctx)
  if (options.withRetry === true) {
    options.adapter.configureRetryPolicies({
      mock: {
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: ['RATE_LIMIT'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    await ctx.plugin(retry, {})
  }
  const install = (inner: Context): void => {
    quota.apply(inner, {}, options.internals === undefined
      ? { now: () => NOW, sleep: async () => true }
      : options.internals)
  }
  const quotaFiber = await ctx.plugin(Object.assign(install, { inject: quota.inject }))
  options.beforeLoop?.(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], options.adapter)
  return { ctx, quotaFiber }
}

function waitForQuota(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/quota-wait') {
        dispose()
        resolve()
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('quota window wait', () => {
  it('probes when the quota clock throws, including a non-error throw', async () => {
    const adapter = new ScriptedAdapter([
      quotaError('quota'),
      textResponse('after throw'),
      quotaError('quota'),
      textResponse('after string'),
    ])
    let thrown: unknown = new Error('clock down')
    ;({ ctx: context } = await harness({
      adapter,
      beforeLoop: (ctx) => {
        ctx.on('llm/quota-window', () => { throw thrown })
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-clock-throw'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    thrown = 'not-an-error'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/quota-wait')).toHaveLength(2)
  })

  it('does not retry when the turn aborts while the quota clock is running', async () => {
    const adapter = new ScriptedAdapter([quotaError('quota')])
    let cancel = (): void => {}
    ;({ ctx: context } = await harness({
      adapter,
      internals: { now: () => NOW, sleep: async () => true },
      beforeLoop: (ctx) => {
        ctx.on('llm/quota-window', () => {
          cancel()
          throw new Error('aborted clock')
        })
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-clock-abort'), {
      provider: 'mock', model: 'mock',
    })
    cancel = () => { agent.cancel({ kind: 'user' }) }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stop' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait')).toBe(false)
  })

  it('rejects an unexpected configuration key', () => {
    const ctx = new Context()
    expect(() => { quota.apply(ctx, { extra: true }) }).toThrow(/unknown key/)
  })

  it('resumes the same step after a 5-hour window and after a weekly window', async () => {
    const intervalReset = NOW + 5 * 60 * 60 * 1000
    const weeklyReset = NOW + 6 * 24 * 60 * 60 * 1000
    const adapter = new ScriptedAdapter([
      quotaError('已达到 Token Plan 用量上限 (2056)'),
      textResponse('after five hours'),
      quotaError('已达到 Token Plan 用量上限 (2056)'),
      textResponse('after the week'),
    ])
    const plans = [
      { window: 'interval' as const, resetAtMs: intervalReset },
      { window: 'weekly' as const, resetAtMs: weeklyReset },
    ]
    ;({ ctx: context } = await harness({
      adapter,
      beforeLoop: (ctx) => {
        ctx.on('llm/quota-window', async () => plans.shift())
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-windows'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue the task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second task' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const waits = agent.session.snapshotEvents().filter(event => event.type === 'llm/quota-wait')
    expect(waits.map(event => event.data)).toEqual([
      expect.objectContaining({
        turn: 1, step: 1, provider: 'mock', window: 'interval',
        resumeAtMs: intervalReset + QUOTA_RESET_GRACE_MS,
        delayMs: intervalReset + QUOTA_RESET_GRACE_MS - NOW,
        failure: { message: '已达到 Token Plan 用量上限 (2056)', code: 'QUOTA_WINDOW', status: 429 },
      }),
      expect.objectContaining({
        turn: 2, step: 1, provider: 'mock', window: 'weekly',
        resumeAtMs: weeklyReset + QUOTA_RESET_GRACE_MS,
      }),
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/quota-wait-started')).toHaveLength(2)
    expect(adapter.requests[0]?.messages).toEqual(adapter.requests[1]?.messages)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason))
      .toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('probes when the clock does not name a reset, then resumes the same task', async () => {
    const delays: number[] = []
    const adapter = new ScriptedAdapter([
      quotaError('quota'),
      quotaError('quota'),
      textResponse('resumed'),
    ])
    ;({ ctx: context } = await harness({
      adapter,
      internals: {
        now: () => NOW,
        sleep: async (delayMs) => {
          delays.push(delayMs)
          return true
        },
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-probe'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'same task' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(delays).toEqual([QUOTA_PROBE_INITIAL_MS, QUOTA_PROBE_INITIAL_MS * 2])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/quota-wait').map(event => event.data.window))
      .toEqual(['unknown', 'unknown'])
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]?.messages).toEqual(adapter.requests[0]?.messages)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'resumed' }],
    })
  })

  it('keeps a short rate limit on the ordinary retry and does not open a quota wait', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('retried quickly'),
    ])
    const delays: number[] = []
    ;({ ctx: context } = await harness({
      adapter,
      withRetry: true,
      internals: {
        now: () => NOW,
        sleep: async (delayMs) => {
          delays.push(delayMs)
          return true
        },
      },
    }))
    const agent = await context.agentLoop.create(SessionId('short-rate-limit'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(delays).toEqual([])
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait')).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(true)
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops the wait when the turn is cancelled and does not retry', async () => {
    const adapter = new ScriptedAdapter([quotaError('quota')])
    ;({ ctx: context } = await harness({
      adapter,
      internals: {
        now: () => NOW,
        sleep: (_delayMs, signal) => {
          if (signal.aborted) return Promise.resolve(false)
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          })
        },
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-cancel'), {
      provider: 'mock', model: 'mock',
    })
    const scheduled = waitForQuota(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stop me' }], source: { kind: 'user' } }))
    await scheduled
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait-started')).toBe(false)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason))
      .toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('keeps a tool result from the same turn and continues that task after the window', async () => {
    const adapter = new ScriptedAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: ToolCallId('noted-call'), name: 'note', arguments: '{}' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      quotaError('quota'),
      textResponse('continued'),
    ])
    ;({ ctx: context } = await harness({ adapter }))
    const agent = await context.agentLoop.create(SessionId('quota-tool-state'), {
      provider: 'mock', model: 'mock',
    })
    context.tools.register(defineContentToolFixture({
      name: 'note', description: '', parameters: {},
      execute: async () => [{ type: 'text', text: 'noted' }],
    }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const toolAt = events.findIndex(event => event.type === 'tool/result')
    const waitAt = events.findIndex(event => event.type === 'llm/quota-wait')
    const answerAt = events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'continued'))
    expect(toolAt).toBeGreaterThan(-1)
    expect(waitAt).toBeGreaterThan(toolAt)
    expect(answerAt).toBeGreaterThan(waitAt)
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('noted')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/quota-wait').every(event => event.data.turn === 1)).toBe(true)
  })

  it('uses the platform clock when no test hooks are supplied and declines other failures', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      quotaError('just opened'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness({
      adapter,
      internals: {},
      beforeLoop: (ctx) => {
        ctx.on('llm/quota-window', async () => ({
          window: 'interval' as const,
          resetAtMs: Date.now() - QUOTA_RESET_GRACE_MS - 1_000,
        }))
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-defaults'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'rate' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'window' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['error', 'completed'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/quota-wait')).toHaveLength(1)
  })

  it('does not schedule a wait when the turn is already aborted', async () => {
    const adapter = new ScriptedAdapter([quotaError('quota'), quotaError('quota')])
    ;({ ctx: context } = await harness({
      adapter,
      beforeQuota: (ctx) => {
        ctx.on('agent/request-error', ({ agent }, next) => {
          agent.cancel({ kind: 'user' })
          return next()
        }, { prepend: true })
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-already-aborted'), {
      provider: 'mock', model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'abort first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait')).toBe(false)
  })

  it('drops the retry when the turn aborts after the clock returns', async () => {
    const adapter = new ScriptedAdapter([quotaError('quota')])
    let cancel = (): void => {}
    ;({ ctx: context } = await harness({
      adapter,
      beforeLoop: (ctx) => {
        ctx.on('llm/quota-window', async () => {
          cancel()
          return { window: 'interval' as const, resetAtMs: NOW + 5_000 }
        })
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-abort-after-clock'), {
      provider: 'mock', model: 'mock',
    })
    cancel = () => { agent.cancel({ kind: 'user' }) }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'clock abort' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait')).toBe(false)
  })

  it('drops the retry when the turn aborts as the wait ends', async () => {
    const adapter = new ScriptedAdapter([quotaError('quota')])
    let cancel = (): void => {}
    ;({ ctx: context } = await harness({
      adapter,
      internals: {
        now: () => NOW,
        sleep: async () => {
          cancel()
          return true
        },
      },
    }))
    const agent = await context.agentLoop.create(SessionId('quota-abort-after-sleep'), {
      provider: 'mock', model: 'mock',
    })
    cancel = () => { agent.cancel({ kind: 'user' }) }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'sleep abort' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait')).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/quota-wait-started')).toBe(false)
    expect(adapter.requests).toHaveLength(1)
  })
})
