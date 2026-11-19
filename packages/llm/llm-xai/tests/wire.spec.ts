/**
 * The route against a local stand-in for `POST /v1/responses`.
 *
 * No real key is used. The stand-in records the path, the bearer token, and
 * the model, then either streams one text delta or returns an error body the
 * classifier must name.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { XAI_PROVIDER, registerXaiProvider } from '../src/index.ts'

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
  readonly body: { readonly model?: string }
}

async function listen(handler: (recorded: Recorded[], raw: string) => { status: number; body: string; sse?: boolean }): Promise<{
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
      } catch {
        body = {}
      }
      recorded.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      })
      const answer = handler(recorded, raw)
      if (answer.sse === true) {
        response.writeHead(answer.status, { 'content-type': 'text/event-stream' })
      } else {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
      }
      response.end(answer.body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no port')
  return { url: `http://127.0.0.1:${address.port}/v1`, recorded }
}

async function finish(baseURL: string): Promise<FinishReason | undefined> {
  vi.stubEnv('XAI_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerXaiProvider(ctx, { baseURL, apiKeyEnv: 'XAI_API_KEY' })
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: XAI_PROVIDER,
    model: 'grok-4.7',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  await ctx.fiber.dispose()
  const finish = chunks.find(chunk => chunk.type === 'finish')
  return finish?.type === 'finish' ? finish.reason : undefined
}

const textSse = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1","content":[]}}',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"hello"}',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
  '',
].join('\n\n')

describe('xAI Responses wire', () => {
  it('posts the flagship model to /v1/responses with the bearer key and streams the text', async () => {
    const { url, recorded } = await listen(() => ({ status: 200, body: textSse, sse: true }))
    const finishReason = await finish(url)
    expect(recorded[0]?.path).toBe('/v1/responses')
    expect(recorded[0]?.authorization).toBe('Bearer test-key')
    expect(recorded[0]?.body.model).toBe('grok-4.7')
    expect(finishReason).toMatchObject({ kind: 'stop' })
  })

  it('classifies a credit cap as quota and a plain 429 as a rate limit', async () => {
    const credits = await listen(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: 'Your team has used all available credits or reached its monthly spending limit.' } }),
    }))
    const creditFinish = await finish(credits.url)
    expect(creditFinish).toMatchObject({ kind: 'error', failure: { code: 'QUOTA' } })

    const limited = await listen(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: 'Too Many Requests' } }),
    }))
    const limitFinish = await finish(limited.url)
    expect(limitFinish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
  })

  it('classifies a rejected key as authentication', async () => {
    const { url } = await listen(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
    }))
    const finishReason = await finish(url)
    expect(finishReason).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
  })
})
