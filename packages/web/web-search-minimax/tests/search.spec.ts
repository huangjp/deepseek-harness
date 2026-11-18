/**
 * MiniMax search over a real local endpoint: what goes on the wire, and what
 * comes back as sources.
 *
 * The provider speaks MiniMax's Anthropic-compatible Messages endpoint with the
 * `web_search_20250305` server tool. Two details are easy to get wrong and are
 * pinned here: the request must not ask for disabled thinking (MiniMax answers
 * `400` on the model that always thinks), and a `pause_turn` reply has to be
 * replayed as the assistant message before the search can finish.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  MINIMAX_SEARCH_PROVIDER_ID,
  MiniMaxSearchProvider,
  mapMiniMaxResponse,
} from '../src/index.ts'

/** One request the endpoint received. */
interface Received {
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown>
}

/** A local Messages endpoint answering from a queue of bodies. */
async function endpoint(
  responses: readonly unknown[],
  status = 200,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      })
      const body = responses[Math.min(received.length - 1, responses.length - 1)]
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing endpoint address')
  return { url: `http://127.0.0.1:${String(address.port)}`, received }
}

/** Options for a provider pointed at `url`. */
function options(url: string, overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'test-key',
    apiKeyEnv: credentialRef('MINIMAX_API_KEY'),
    baseURL: url,
    model: 'MiniMax-M3.1-Flash',
    maxTokens: 4096,
    maxUses: 3,
    serviceTier: 'standard' as const,
    ...overrides,
  }
}

/** One successful search response. */
function resultsResponse() {
  return {
    content: [
      { type: 'text', text: 'Let me search.' },
      { type: 'server_tool_use', id: 'call_1', name: 'web_search', input: { query: 'weather' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'call_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://example.test/a',
            title: 'Example A',
            page_age: '2026/10/17 07:08:47',
            content: 'excerpt A',
          },
          { type: 'web_search_result', url: 'https://example.test/b', title: 'Example B' },
          { type: 'web_search_result', url: 'https://example.test/a', title: 'duplicate' },
        ],
      },
      { type: 'text', text: 'The weather is fine.' },
    ],
    stop_reason: 'end_turn',
  }
}

describe('MiniMax search provider', () => {
  it('reports unusable options as unavailable instead of searching', () => {
    expect(new MiniMaxSearchProvider(() => options('http://127.0.0.1:1')).available()).toBe(true)
    expect(new MiniMaxSearchProvider(() => options('http://127.0.0.1:1', { apiKey: '' })).available()).toBe(false)
    expect(new MiniMaxSearchProvider(() => options('not a url')).available()).toBe(false)
    expect(new MiniMaxSearchProvider(() => options('http://127.0.0.1:1', { maxUses: 0 })).available()).toBe(false)
  })

  it('declares the server tool without disabling thinking', async () => {
    const server = await endpoint([resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url))
    expect(provider.id).toBe(MINIMAX_SEARCH_PROVIDER_ID)

    await provider.search({ query: 'weather in Shanghai' })

    const request = server.received[0]
    expect(request?.path).toBe('/v1/messages')
    expect(request?.headers['authorization']).toBe('Bearer test-key')
    expect(request?.headers['anthropic-version']).toBe('2023-06-01')
    expect(request?.body).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      // Never `thinking: {type: 'disabled'}`: MiniMax-M3.1-Flash rejects it.
      output_config: { effort: 'low' },
    })
    expect(request?.body).not.toHaveProperty('thinking')
    expect(JSON.stringify(request?.body['messages'])).toContain('weather in Shanghai')
  })

  it('maps results to deduplicated sources with their excerpt and publication age', async () => {
    const server = await endpoint([resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url))

    const result = await provider.search({ query: 'weather' })

    expect(result).toEqual({
      truncated: false,
      sources: [
        {
          url: 'https://example.test/a',
          title: 'Example A',
          snippet: 'excerpt A',
          publishedAt: '2026/10/17 07:08:47',
        },
        { url: 'https://example.test/b', title: 'Example B' },
      ],
    })
  })

  it('bounds results when the caller asks for fewer and marks the truncation', async () => {
    const server = await endpoint([resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url))

    const result = await provider.search({ query: 'weather', maxResults: 1 })

    expect(result.truncated).toBe(true)
    expect(result.sources.map(source => source.url)).toEqual(['https://example.test/a'])
  })

  it('replays a paused turn and continues the search', async () => {
    const paused = {
      content: [
        { type: 'server_tool_use', id: 'call_1', name: 'web_search', input: { query: 'weather' } },
        { type: 'web_search_tool_result', tool_use_id: 'call_1', content: [] },
      ],
      stop_reason: 'pause_turn',
    }
    const server = await endpoint([paused, resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url))

    const result = await provider.search({ query: 'weather' })

    expect(server.received).toHaveLength(2)
    const replay = server.received[1]?.body['messages'] as { role: string }[]
    expect(replay.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(result.sources).toHaveLength(2)
  })

  it('asks for the priority tier when the deployment configures it', async () => {
    const server = await endpoint([resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url, { serviceTier: 'priority' }))

    await provider.search({ query: 'weather' })

    expect(server.received[0]?.body).toMatchObject({ service_tier: 'priority' })
  })

  it('asks for the standard tier when the deployment configures it', async () => {
    const server = await endpoint([resultsResponse()])
    const provider = new MiniMaxSearchProvider(() => options(server.url, { serviceTier: 'standard' }))

    await provider.search({ query: 'weather' })

    expect(server.received[0]?.body).toMatchObject({ service_tier: 'standard' })
  })

  it('fails loudly when the turn produced no search result', async () => {
    const server = await endpoint([{ content: [{ type: 'text', text: 'no search ran' }], stop_reason: 'end_turn' }])
    const provider = new MiniMaxSearchProvider(() => options(server.url))

    await expect(provider.search({ query: 'weather' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('names the endpoint when the request fails', async () => {
    const server = await endpoint([{ error: { message: 'nope' } }], 500)
    const provider = new MiniMaxSearchProvider(() => options(server.url))

    const failure = await provider.search({ query: 'weather' }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect((failure as Error).message).toContain(server.url)
  })

  it('refuses to search without a credential', async () => {
    const provider = new MiniMaxSearchProvider(() => options('http://127.0.0.1:1', { apiKey: undefined }))

    await expect(provider.search({ query: 'weather' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })

  it('falls back to citation excerpts when a result carries none', () => {
    const mapped = mapMiniMaxResponse({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'call_1',
          content: [{ type: 'web_search_result', url: 'https://example.test/c', title: 'C' }],
        },
        {
          type: 'text',
          text: 'answer',
          citations: [{ url: 'https://example.test/c', cited_text: 'cited excerpt' }],
        },
      ],
    })

    expect(mapped.sources).toEqual([
      { url: 'https://example.test/c', title: 'C', snippet: 'cited excerpt' },
    ])
  })
})
