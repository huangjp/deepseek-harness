/**
 * MiniMax plan-window 429s are a different failure from a short rate limit.
 * The Messages body carries the plan code and no reset time; the usage clock
 * names which window is binding.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { MINIMAX_PROVIDER, registerMiniMaxProvider } from '../src/index.ts'
import {
  classifyMiniMaxProviderError,
  minimaxQuotaClockUrls,
  readMiniMaxQuotaWindow,
  readMiniMaxRemainingRatio,
  resolveMiniMaxQuotaWindow,
} from '../src/quota.ts'

const WINDOW_MESSAGE = '已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)'
const RATE_MESSAGE = '触发 RPM/TPM/连接数 等限流'
const NOW = 1_700_000_000_000
const FIVE_HOURS = 5 * 60 * 60 * 1000
const WEEK = 7 * 24 * 60 * 60 * 1000

function clockBody(row: Record<string, unknown>, statusCode = 0): unknown {
  return {
    model_remains: [row],
    base_resp: { status_code: statusCode, status_msg: statusCode === 0 ? 'success' : 'rejected' },
  }
}

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env['MINIMAX_QUOTA_TEST_KEY']
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
})

describe('classifyMiniMaxProviderError', () => {
  it.each([
    `429 ${WINDOW_MESSAGE}`,
    `429 {"type":"error","error":{"type":"rate_limit_error","message":"${WINDOW_MESSAGE}"}}`,
    '当前已达到 Token Plan 用量上限。请升级套餐或开启积分自动消耗。 (2067)',
    '超出M Plan资源限制',
    'Token Plan usage limit reached (2056)',
    '套餐额度已用完',
    'Token Plan usage limit reached',
  ])('classifies a plan window: %s', (message) => {
    expect(classifyMiniMaxProviderError(message)).toBe('QUOTA_WINDOW')
  })

  it.each([
    `429 ${RATE_MESSAGE}`,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"触发 RPM/TPM/连接数 等限流"}}',
    '超出 M Plan 速率限制 (2062)',
    '请求频率超限 (1002)',
    '429 You exceeded your current quota, please check your plan and billing details.',
    'HTTP 500 backend down',
    'Token Plan is ready',
  ])('leaves a short limit or a billing quota to the shared map: %s', (message) => {
    expect(classifyMiniMaxProviderError(message)).toBeUndefined()
  })
})

describe('readMiniMaxQuotaWindow', () => {
  it('uses the 5-hour end when only that window is exhausted', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      end_time: NOW + FIVE_HOURS,
      current_interval_remaining_percent: 0,
      current_interval_status: 2,
      weekly_end_time: NOW + WEEK,
      current_weekly_remaining_percent: 40,
      current_weekly_status: 1,
    }), NOW)).toEqual({ window: 'interval', resetAtMs: NOW + FIVE_HOURS })
  })

  it('uses the weekly end when that window is exhausted, including when the 5-hour window is too', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      end_time: NOW + FIVE_HOURS,
      current_interval_remaining_percent: 0,
      current_interval_status: 2,
      weekly_end_time: NOW + WEEK,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 2,
    }), NOW)).toEqual({ window: 'weekly', resetAtMs: NOW + WEEK })
  })

  it('accepts epoch seconds and a zero percent with status still available', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      end_time: (NOW + FIVE_HOURS) / 1000,
      current_interval_remaining_percent: 0,
      current_interval_status: 1,
      weekly_end_time: (NOW + WEEK) / 1000,
      current_weekly_remaining_percent: 10,
      current_weekly_status: 1,
    }), NOW)).toEqual({ window: 'interval', resetAtMs: NOW + FIVE_HOURS })
  })

  it('prefers the general bucket over a video bucket that is not in the plan', () => {
    expect(readMiniMaxQuotaWindow({
      model_remains: [
        { model_name: 'video', current_interval_status: 3, current_weekly_status: 3 },
        {
          model_name: 'general',
          end_time: NOW + FIVE_HOURS,
          current_interval_status: 2,
          weekly_end_time: NOW + WEEK,
          current_weekly_remaining_percent: 80,
          current_weekly_status: 1,
        },
      ],
    }, NOW)).toEqual({ window: 'interval', resetAtMs: NOW + FIVE_HOURS })
  })

  it('ignores a reset that is not an epoch', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      end_time: 1,
      current_interval_status: 2,
      weekly_end_time: 1e20,
      current_weekly_status: 2,
    }), NOW)).toEqual({ window: 'unknown' })
  })

  it('treats status 3 as not part of the plan', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      current_interval_status: 3,
      current_weekly_status: 3,
      current_interval_remaining_percent: 0,
    }), NOW)).toBeUndefined()
  })

  it('skips an image bucket and ignores a non-finite percent', () => {
    expect(readMiniMaxQuotaWindow({
      model_remains: [
        { model_name: 'image', current_interval_status: 2 },
        {
          model_name: 'speech',
          end_time: NOW + FIVE_HOURS,
          current_interval_remaining_percent: Number.NaN,
          current_interval_status: 1,
          current_weekly_remaining_percent: '0',
          current_weekly_status: 1,
        },
      ],
    }, NOW)).toBeUndefined()
  })

  it('continues when a clock body parses but names no window', async () => {
    await expect(resolveMiniMaxQuotaWindow({
      baseURL: 'https://www.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      fetch: async () => new Response('{}', { status: 200 }),
    })).resolves.toEqual({ window: 'unknown' })
  })

  it('uses a row that does not name a model when general is absent', () => {
    expect(readMiniMaxQuotaWindow({
      model_remains: [
        'skip-me',
        {
          end_time: NOW + FIVE_HOURS,
          current_interval_status: 2,
          current_weekly_remaining_percent: 10,
          current_weekly_status: 1,
        },
      ],
    }, NOW)).toEqual({ window: 'interval', resetAtMs: NOW + FIVE_HOURS })
  })

  it('returns unknown when a window is exhausted but its reset already passed', () => {
    expect(readMiniMaxQuotaWindow(clockBody({
      model_name: 'general',
      end_time: NOW - 1_000,
      current_interval_status: 2,
      weekly_end_time: NOW - 1_000,
      current_weekly_status: 2,
    }), NOW)).toEqual({ window: 'unknown' })
  })

  it.each([
    null,
    {},
    clockBody({ model_name: 'general', current_interval_remaining_percent: 20, current_weekly_remaining_percent: 20 }, 0),
    clockBody({ model_name: 'general', current_interval_status: 2 }, 1004),
    { model_remains: [{ model_name: 'video', current_interval_status: 3 }] },
  ])('rejects a body that does not name a future reset', (body) => {
    const plan = readMiniMaxQuotaWindow(body, NOW)
    expect(plan === undefined || plan.resetAtMs === undefined).toBe(true)
    if (plan?.window === 'interval' || plan?.window === 'weekly') {
      throw new Error('a rejected clock must not name a window')
    }
  })
})

describe('resolveMiniMaxQuotaWindow', () => {
  it('lists the API host, the www host, and both clock paths', () => {
    expect(minimaxQuotaClockUrls('https://api.minimax.cn/anthropic')).toEqual([
      'https://api.minimax.cn/v1/token_plan/remains',
      'https://api.minimax.cn/v1/coding_plan/remains',
      'https://www.minimax.cn/v1/token_plan/remains',
      'https://www.minimax.cn/v1/coding_plan/remains',
    ])
    expect(minimaxQuotaClockUrls('not a url')).toEqual([])
    expect(minimaxQuotaClockUrls('https://www.minimax.cn/anthropic')).toEqual([
      'https://www.minimax.cn/v1/token_plan/remains',
      'https://www.minimax.cn/v1/coding_plan/remains',
    ])
  })

  it('uses the first clock that names a window', async () => {
    const urls: string[] = []
    const plan = await resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      now: () => NOW,
      fetch: async (input, init) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const header = new Headers(init?.headers).get('authorization')
        expect(header).toBe('Bearer secret')
        if (urls.length === 1) return new Response('nope', { status: 404 })
        return new Response(JSON.stringify(clockBody({
          model_name: 'general',
          weekly_end_time: NOW + WEEK,
          current_weekly_status: 2,
          current_interval_remaining_percent: 10,
          current_interval_status: 1,
        })), { status: 200 })
      },
    })
    expect(urls).toEqual([
      'https://api.minimax.cn/v1/token_plan/remains',
      'https://api.minimax.cn/v1/coding_plan/remains',
    ])
    expect(plan).toEqual({ window: 'weekly', resetAtMs: NOW + WEEK })
  })

  it('skips a clock that throws and one whose body cannot be read', async () => {
    let calls = 0
    const recovered = await resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      now: () => NOW,
      fetch: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('down'))
        return Promise.resolve(new Response(JSON.stringify(clockBody({
          model_name: 'general',
          end_time: NOW + FIVE_HOURS,
          current_interval_status: 2,
          current_weekly_remaining_percent: 10,
          current_weekly_status: 1,
        })), { status: 200 }))
      },
    })
    expect(recovered).toEqual({ window: 'interval', resetAtMs: NOW + FIVE_HOURS })

    const signal = new AbortController()
    const aborted = await resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: signal.signal,
      fetch: () => {
        signal.abort()
        return Promise.reject(new Error('aborted'))
      },
    })
    expect(aborted).toEqual({ window: 'unknown' })

    const huge = 'x'.repeat(1_000_001)
    await expect(resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.io/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      fetch: async () => {
        const response = new Response('clock', { status: 200 })
        response.text = () => Promise.reject(new Error('unreadable'))
        return response
      },
    })).resolves.toEqual({ window: 'unknown' })
    await expect(resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.io/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      fetch: async () => new Response(huge, { status: 200 }),
    })).resolves.toEqual({ window: 'unknown' })
  })

  it('probes when every clock fails and stops when the turn is aborted', async () => {
    const signal = new AbortController()
    signal.abort()
    await expect(resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: signal.signal,
      fetch: () => { throw new Error('must not fetch') },
    })).resolves.toEqual({ window: 'unknown' })

    await expect(resolveMiniMaxQuotaWindow({
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKey: 'secret',
      signal: new AbortController().signal,
      fetch: async () => new Response('not-json', { status: 200 }),
    })).resolves.toEqual({ window: 'unknown' })
  })
})

describe('MiniMax route', () => {
  async function finishFor(status: number, body: unknown): Promise<FinishReason> {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('mock server has no port')
    process.env['MINIMAX_QUOTA_TEST_KEY'] = 'test-key'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    registerMiniMaxProvider(ctx, {
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: MINIMAX_PROVIDER,
      model: 'MiniMax-M3',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    await ctx.fiber.dispose()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    if (finish === undefined || finish.type !== 'finish') throw new Error('stream produced no finish')
    return finish.reason
  }

  it('degrades unusable replay state once per reason and still classifies the 429', async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: WINDOW_MESSAGE } }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('mock server has no port')
    process.env['MINIMAX_QUOTA_TEST_KEY'] = 'test-key'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const warn = vi.spyOn(ctx.logger, 'warn')
    registerMiniMaxProvider(ctx, {
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    const prior = createAssistantMessage({
      content: [{ type: 'text', text: 'earlier' }],
      source: {
        provider: MINIMAX_PROVIDER, model: 'MiniMax-M3', replayState: { bogus: true },
      },
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: MINIMAX_PROVIDER,
      model: 'MiniMax-M3',
      messages: [
        prior,
        prior,
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      ],
    })) chunks.push(chunk)
    await ctx.fiber.dispose()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_WINDOW' } } })
    const warnings: string[] = []
    for (const call of warn.mock.calls) {
      const value: unknown = call[0]
      if (typeof value === 'string') warnings.push(value)
    }
    expect(warnings.filter(message => message.includes('unusable Messages replay')).length).toBe(1)
  })

  it('maps a plan-window 429 to QUOTA_WINDOW and a short 429 to RATE_LIMIT', async () => {
    const window = await finishFor(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: WINDOW_MESSAGE },
    })
    expect(window).toMatchObject({ kind: 'error', failure: { code: 'QUOTA_WINDOW' } })
    if (window.kind === 'error') expect(window.failure.message).toContain('2056')

    const rate = await finishFor(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: RATE_MESSAGE },
    })
    expect(rate).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
  })

  it('answers the quota-window waterfall from the usage clock', async () => {
    const intervalEnd = Date.now() + FIVE_HOURS
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(clockBody({
      model_name: 'general',
      end_time: intervalEnd,
      current_interval_status: 2,
      weekly_end_time: Date.now() + WEEK,
      current_weekly_remaining_percent: 50,
      current_weekly_status: 1,
    })), { status: 200 }))
    process.env['MINIMAX_QUOTA_TEST_KEY'] = 'test-key'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    registerMiniMaxProvider(ctx, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    const plan = await ctx.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)
    expect(plan).toEqual({ window: 'interval', resetAtMs: intervalEnd })

    const other = await ctx.waterfall('llm/quota-window', {
      provider: 'other',
      failure: { message: 'nope', code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)
    expect(other).toBeUndefined()

    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: aborted.signal,
    }, async () => undefined)).resolves.toEqual({ window: 'unknown' })

    class StoredKey extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = async (): Promise<{ value: string }> => ({ value: ' stored-key ' })
    }
    const withKey = new Context()
    await withKey.plugin(LlmRuntime)
    await withKey.plugin(StoredKey)
    registerMiniMaxProvider(withKey, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(withKey.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toMatchObject({ window: 'interval' })
    await withKey.fiber.dispose()

    class EmptyKey extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = async (): Promise<undefined> => undefined
    }
    const empty = new Context()
    await empty.plugin(LlmRuntime)
    await empty.plugin(EmptyKey)
    registerMiniMaxProvider(empty, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(empty.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toEqual({ window: 'unknown' })
    await empty.fiber.dispose()

    const aborting = new AbortController()
    class AbortingKey extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = (): never => {
        aborting.abort()
        throw new Error('late')
      }
    }
    const abortCtx = new Context()
    await abortCtx.plugin(LlmRuntime)
    await abortCtx.plugin(AbortingKey)
    registerMiniMaxProvider(abortCtx, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(abortCtx.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: aborting.signal,
    }, async () => undefined)).resolves.toEqual({ window: 'unknown' })
    await abortCtx.fiber.dispose()

    class BrokenKey extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = (): never => { throw 'boom' }
    }
    const broken = new Context()
    await broken.plugin(LlmRuntime)
    await broken.plugin(BrokenKey)
    registerMiniMaxProvider(broken, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(broken.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toEqual({ window: 'unknown' })
    await broken.fiber.dispose()

    delete process.env['MINIMAX_QUOTA_TEST_KEY']
    await expect(ctx.waterfall('llm/quota-window', {
      provider: MINIMAX_PROVIDER,
      failure: { message: WINDOW_MESSAGE, code: 'QUOTA_WINDOW' },
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toEqual({ window: 'unknown' })
    await ctx.fiber.dispose()
  })

  it('answers the quota-remaining waterfall from the usage clock', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(clockBody({
      model_name: 'general',
      current_interval_remaining_percent: 40,
      current_weekly_remaining_percent: 12,
    })), { status: 200 }))
    process.env['MINIMAX_QUOTA_TEST_KEY'] = 'test-key'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    registerMiniMaxProvider(ctx, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(ctx.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toEqual({ remainingRatio: 0.12 })
    await expect(ctx.waterfall('llm/quota-remaining', {
      provider: 'other',
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: aborted.signal,
    }, async () => undefined)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', async () => new Response('null', { status: 200 }))
    await expect(ctx.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', async () => { throw new Error('clock down') })
    await expect(ctx.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toBeUndefined()
    class BrokenRemaining extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = (): never => { throw new Error('remaining down') }
    }
    const broken = new Context()
    await broken.plugin(LlmRuntime)
    await broken.plugin(BrokenRemaining)
    registerMiniMaxProvider(broken, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(broken.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toBeUndefined()
    await broken.fiber.dispose()
    class TextRemaining extends Service {
      constructor(ctx: Context) { super(ctx, 'credentials') }
      resolve = (): never => { throw 'remaining' }
    }
    const text = new Context()
    await text.plugin(LlmRuntime)
    await text.plugin(TextRemaining)
    registerMiniMaxProvider(text, {
      baseURL: 'https://api.minimax.cn/anthropic',
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    await expect(text.waterfall('llm/quota-remaining', {
      provider: MINIMAX_PROVIDER,
      signal: new AbortController().signal,
    }, async () => undefined)).resolves.toBeUndefined()
    await text.fiber.dispose()
    delete process.env['MINIMAX_QUOTA_TEST_KEY']
    await ctx.fiber.dispose()
  })

  it('forwards an image attachment through the route filesystem mapping', async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: RATE_MESSAGE } }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('mock server has no port')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    class ImageStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
        maxImagePixels: 1, maxImageDimension: 8, mediaTypes: ['image/png'],
      }
      validateImage(): Promise<void> { return Promise.resolve() }
      saveImage(): Promise<ImageAttachmentRef> { return Promise.reject(new Error('unused')) }
      readImage(): Promise<StoredImageAttachment> { return Promise.resolve({ ref, data: Uint8Array.of(1) }) }
      override imageHostPath(): string { return '/host/image.png' }
      override readImageRequest(
        value: ImageAttachmentRef,
        _target: ImageRequestTarget,
      ): Promise<RequestImageAttachment> {
        return Promise.resolve({
          variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
          attachment: value,
          data: Uint8Array.of(1),
          mediaType: value.mediaType,
          bytes: 1,
          width: 1,
          height: 1,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: true,
        })
      }
    }
    class MappedFs extends Service {
      constructor(ctx: Context) { super(ctx, 'fs') }
      processPathFromHostPath(hostPath: string): string | undefined {
        return hostPath === '/host/image.png' ? '/model/image.png' : undefined
      }
    }
    process.env['MINIMAX_QUOTA_TEST_KEY'] = 'test-key'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ImageStore)
    await ctx.plugin(MappedFs)
    registerMiniMaxProvider(ctx, {
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: 'MINIMAX_QUOTA_TEST_KEY',
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: MINIMAX_PROVIDER,
      model: 'MiniMax-M3',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    await ctx.fiber.dispose()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })
  })
})

describe('MiniMax remaining ratio', () => {
  it('uses the tighter of the two windows', () => {
    expect(readMiniMaxRemainingRatio({
      base_resp: { status_code: 0 },
      model_remains: [{
        model_name: 'general',
        current_interval_remaining_percent: 40,
        current_weekly_remaining_percent: 12,
      }],
    })).toBe(0.12)
    expect(readMiniMaxRemainingRatio({ base_resp: { status_code: 1 } })).toBeUndefined()
    expect(readMiniMaxRemainingRatio(null)).toBeUndefined()
    expect(readMiniMaxRemainingRatio({ base_resp: { status_code: 0 }, model_remains: 'nope' })).toBeUndefined()
    expect(readMiniMaxRemainingRatio({ base_resp: { status_code: 0 }, model_remains: [] })).toBeUndefined()
    expect(readMiniMaxRemainingRatio({
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 'soon' }],
    })).toBeUndefined()
  })
})
