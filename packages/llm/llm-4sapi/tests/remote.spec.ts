import { describe, expect, it } from 'vitest'
import { fetchFoursapiModels, fetchFoursapiPricing, fetchFoursapiRemainingRatio } from '../src/remote.ts'

interface Call {
  url: string
  authorization: string | undefined
}

function jsonFetch(handler: (url: string, authorization: string | undefined) => Response): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') ?? undefined })
    return Promise.resolve(handler(url, headers.get('authorization') ?? undefined))
  }
  return { fetch: fetchImpl, calls }
}

describe('4SAPI remote reads', () => {
  it('lists models with the bearer key and treats 401 as unauthorized', async () => {
    const ok = jsonFetch(() => Response.json({ data: [{ id: 'demo' }] }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com',
      apiKey: 'sk-test',
      fetch: ok.fetch,
    })).resolves.toEqual({ kind: 'list', models: [{ id: 'demo' }] })
    expect(ok.calls[0]).toEqual({
      url: 'https://4sapi.com/v1/models',
      authorization: 'Bearer sk-test',
    })

    const denied = jsonFetch(() => new Response('no', { status: 401 }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: denied.fetch,
    })).resolves.toEqual({ kind: 'unauthorized' })
    const forbidden = jsonFetch(() => new Response('no', { status: 403 }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: forbidden.fetch,
    })).resolves.toEqual({ kind: 'unauthorized' })
  })

  it('reports a transport failure, a non-JSON body, and an oversized reply as failed', async () => {
    const down = jsonFetch(() => { throw new Error('reset') })
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: down.fetch,
    })).resolves.toEqual({ kind: 'failed' })

    const text = jsonFetch(() => new Response('not-json', { status: 200 }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: text.fetch,
    })).resolves.toEqual({ kind: 'failed' })

    const status = jsonFetch(() => new Response('no', { status: 500 }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: status.fetch,
    })).resolves.toEqual({ kind: 'failed' })

    const huge = jsonFetch(() => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: huge.fetch,
    })).resolves.toEqual({ kind: 'failed' })

    const longBody = jsonFetch(() => new Response(`{"data":[]}${' '.repeat(4 * 1024 * 1024)}`, { status: 200 }))
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: longBody.fetch,
    })).resolves.toEqual({ kind: 'failed' })

    const broken = new Response(new ReadableStream({
      start(controller) { controller.error(new Error('read failed')) },
    }), { status: 200 })
    const failing: typeof fetch = () => Promise.resolve(broken)
    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: failing,
    })).resolves.toEqual({ kind: 'failed' })

    await expect(fetchFoursapiModels({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      signal: AbortSignal.abort(),
      fetch: jsonFetch(() => Response.json({})).fetch,
    })).resolves.toEqual({ kind: 'failed' })

    await expect(fetchFoursapiModels({
      baseURL: 'not a url',
      apiKey: 'sk-test',
      fetch: jsonFetch(() => Response.json({})).fetch,
    })).resolves.toEqual({ kind: 'failed' })
  })

  it('reads public prices without a key and ignores a failed pricing endpoint', async () => {
    const ok = jsonFetch(() => Response.json({
      success: true,
      data: [{ model_name: 'demo', quota_type: 0, model_ratio: 1, completion_ratio: 1 }],
    }))
    const prices = await fetchFoursapiPricing({ baseURL: 'https://4sapi.org/v1', fetch: ok.fetch })
    expect(prices).toEqual([{ model: 'demo', inputPerMillion: 2, outputPerMillion: 2, currency: 'USD' }])
    expect(ok.calls[0]?.authorization).toBeUndefined()
    expect(ok.calls[0]?.url).toBe('https://4sapi.org/api/pricing')

    const denied = jsonFetch(() => new Response('no', { status: 500 }))
    await expect(fetchFoursapiPricing({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: denied.fetch,
    })).resolves.toEqual([])
    expect(denied.calls[0]?.authorization).toBe('Bearer sk-test')
    await expect(fetchFoursapiPricing({ baseURL: 'not a url' })).resolves.toEqual([])
  })

  it('combines the billing pair into a remaining fraction', async () => {
    const ok = jsonFetch((url) => {
      if (url.endsWith('/subscription')) return Response.json({ hard_limit_usd: 4 })
      return Response.json({ total_usage: 100 })
    })
    await expect(fetchFoursapiRemainingRatio({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: ok.fetch,
    })).resolves.toBe(0.75)

    const down = jsonFetch(url => (
      url.endsWith('/usage') ? new Response('no', { status: 500 }) : Response.json({ hard_limit_usd: 4 })
    ))
    await expect(fetchFoursapiRemainingRatio({
      baseURL: 'https://4sapi.com/v1',
      apiKey: 'sk-test',
      fetch: down.fetch,
    })).resolves.toBeUndefined()
    await expect(fetchFoursapiRemainingRatio({
      baseURL: 'not a url',
      apiKey: 'sk-test',
    })).resolves.toBeUndefined()
  })
})
