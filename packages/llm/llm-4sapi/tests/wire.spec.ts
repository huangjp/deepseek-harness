/**
 * The route against a local stand-in for chat completions and Messages.
 *
 * No real key is used. The stand-in records the path and the credential
 * header, then either streams one text delta or returns an error body.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { FOURSAPI_PROVIDER, registerFoursapiProvider } from '../src/index.ts'
import type { FoursapiClaudeProtocol } from '../src/index.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
  vi.unstubAllEnvs()
})

interface Recorded {
  readonly path: string
  readonly authorization: string | undefined
  readonly apiKey: string | undefined
  readonly body: { readonly model?: string }
}

async function listen(handler: (recorded: Recorded) => { status: number; body: string; sse?: boolean }): Promise<{
  url: string
  recorded: Recorded[]
}> {
  const recorded: Recorded[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: { model?: string } = {}
      try {
        body = JSON.parse(raw) as { model?: string }
      } catch (error: unknown) {
        // A body that is not JSON still records the path and headers.
        void error
        body = {}
      }
      const entry: Recorded = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        body,
      }
      recorded.push(entry)
      const answer = handler(entry)
      if (answer.sse === true) response.writeHead(answer.status, { 'content-type': 'text/event-stream' })
      else response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(answer.body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no port')
  return { url: `http://127.0.0.1:${address.port}/v1`, recorded }
}

const textSse = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  'data: [DONE]',
  '',
].join('\n\n')

async function finish(
  baseURL: string,
  model: string,
  protocol: FoursapiClaudeProtocol = 'openai',
): Promise<FinishReason | undefined> {
  vi.stubEnv('FOURSAPI_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerFoursapiProvider(ctx, {
    baseURL: () => baseURL,
    apiKeyEnv: () => 'FOURSAPI_API_KEY',
    claudeProtocol: () => protocol,
    models: () => [{ id: model, vision: true }],
    pricing: () => [],
    usePricingEndpoint: () => false,
  })
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: FOURSAPI_PROVIDER,
    model,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  await ctx.fiber.dispose()
  const done = chunks.find(chunk => chunk.type === 'finish')
  return done?.type === 'finish' ? done.reason : undefined
}

describe('4SAPI wire', () => {
  it('posts chat completions with the bearer key and streams the text', async () => {
    const { url, recorded } = await listen(() => ({ status: 200, body: textSse, sse: true }))
    const reason = await finish(url, 'demo')
    expect(recorded[0]?.path).toBe('/v1/chat/completions')
    expect(recorded[0]?.authorization).toBe('Bearer test-key')
    expect(recorded[0]?.body.model).toBe('demo')
    expect(reason).toMatchObject({ kind: 'stop' })
  })

  it('posts claude ids to Messages when that protocol is selected', async () => {
    const { url, recorded } = await listen(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: '无效的令牌', code: 'invalid_token' } }),
    }))
    const reason = await finish(url, 'claude-sonnet-4-5', 'anthropic')
    expect(recorded[0]?.path.startsWith('/v1/messages')).toBe(true)
    expect(recorded[0]?.apiKey ?? recorded[0]?.authorization).toBeTruthy()
    expect(recorded[0]?.body.model).toBe('claude-sonnet-4-5')
    expect(reason).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
  })

  it('classifies quota, rate limit, and a missing channel', async () => {
    const quota = await listen(() => ({
      status: 403,
      body: JSON.stringify({ error: { message: '用户额度不足', code: 'insufficient_user_quota' } }),
    }))
    expect(await finish(quota.url, 'demo')).toMatchObject({ kind: 'error', failure: { code: 'QUOTA' } })

    const limited = await listen(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: '当前分组上游负载已饱和' } }),
    }))
    expect(await finish(limited.url, 'demo')).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })

    const channel = await listen(() => ({
      status: 503,
      body: JSON.stringify({ error: { message: '当前分组 default 下对于模型 demo 无可用渠道' } }),
    }))
    expect(await finish(channel.url, 'demo')).toMatchObject({ kind: 'error', failure: { code: 'SERVER' } })
  })
})
