/**
 * The built-in local-bridge routes: the three fixed provider paths the desktop
 * app ships, the capabilities each one declares, and the fact that the Models
 * page may list them without offering to remove one.
 *
 * The declared modalities are load-bearing rather than cosmetic. A route that
 * claims `image` makes the harness attach an image to the request; the Copilot
 * and Celia upstreams carry no attachment field, so that image would be
 * rejected after the message was already recorded. Declaring `text` refuses
 * the attachment before the request instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LocalBridge from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the LLM runtime and the local-bridge routes over it. */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  // The plugin asks the settings service not to generate a page for its
  // namespace; the stub only has to accept that instruction.
  ctx.provide('settings', { configure: () => {} } as never)
  await ctx.plugin(LocalBridge)
  return ctx
}

describe('built-in local-bridge routes', () => {
  it('registers the three relay routes and nothing else', async () => {
    const ctx = await mounted()
    expect(ctx.llm.listProviders().map(provider => provider.id).sort())
      .toEqual(['dpv41f', 'hwcelia', 'slefgpt56'])
  })

  it('names each route after the relay behind it', async () => {
    const ctx = await mounted()
    expect(ctx.llm.listProviders().map(provider => provider.name).sort())
      .toEqual(['Copilot Local Bridge', 'Huawei Celia Local Bridge', 'WorkBuddy Local Bridge'])
  })

  it('declares image input only on the WorkBuddy route', async () => {
    const ctx = await mounted()
    const modalities = async (provider: string): Promise<Record<string, readonly string[] | undefined>> => {
      const models = await ctx.llm.listModels(provider)
      return Object.fromEntries(models.map(model => [model.id, model.inputModalities]))
    }
    // The WorkBuddy relay drops an image on disk and lets its own agent read
    // the file, so the image is honoured there.
    expect(await modalities('dpv41f')).toEqual({
      'deepseek-v4.1-flash': ['text', 'image'],
      'gpt-4o': ['text', 'image'],
      'gpt-3.5-turbo': ['text', 'image'],
      'default': ['text', 'image'],
    })
    // The Copilot chatHub frame and the Celia WebSocket frame carry one plain
    // text prompt and no attachment field.
    expect(await modalities('slefgpt56')).toEqual({
      'copilot': ['text'],
      'm365-copilot': ['text'],
    })
    expect(await modalities('hwcelia')).toEqual({
      'xiaoyi-chat': ['text'],
      'xiaoyi': ['text'],
    })
  })

  it('lists every route without a removable settings path', async () => {
    const ctx = await mounted()
    const entries = ctx.llm.listConfigurableProviders()
    expect(entries.map(entry => entry.provider).sort()).toEqual(['dpv41f', 'hwcelia', 'slefgpt56'])
    // An empty path is what denies the Models page a delete control, exactly
    // as it does for the built-in `deepseek-official` route.
    for (const entry of entries) expect(entry.settingsPath).toEqual([])
  })

  it('sends one request per route without asking for a credential', async () => {
    const ctx = await mounted()
    const requests: { url: string; headers: Headers }[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) })
      return new Response([
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash",'
          + '"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash",'
          + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    for (const provider of ['dpv41f', 'slefgpt56', 'hwcelia']) {
      const chunks: unknown[] = []
      for await (const chunk of ctx.llm.stream({
        provider,
        model: provider === 'hwcelia' ? 'xiaoyi-chat' : provider === 'slefgpt56' ? 'copilot' : 'deepseek-v4.1-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })) {
        chunks.push(chunk)
      }
      expect(chunks.length).toBeGreaterThan(0)
    }
    // Each route reaches its own relay, and the placeholder header
    // authenticates the request without a stored credential.
    expect(requests.map(request => request.url).sort()).toEqual([
      'http://127.0.0.1:8123/v1/chat/completions',
      'http://127.0.0.1:8787/v1/chat/completions',
      'http://127.0.0.1:8899/v1/chat/completions',
    ])
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe('Bearer local-bridge')
    }
  })
})
