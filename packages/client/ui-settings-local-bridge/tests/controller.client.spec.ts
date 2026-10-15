/**
 * The local-model-relay page's stores: what they accept at the wire, which read
 * wins when two are in flight, and how the page observes a refresh attempt the
 * host runs as a detached one-to-two-minute process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_BRIDGE_LOG_ROUTE, LOCAL_BRIDGE_REFRESH_ROUTE, LOCAL_BRIDGE_STATUS_ROUTE,
} from '@deepseek-ai/dsh-host-local-bridge/shared'
import {
  LocalBridgeController, parseLogPayload, parseRefreshPayload, parseStatusPayload, refreshInFlight,
} from '../src/client/controller.ts'

afterEach(() => { vi.useRealTimers() })

/** One status snapshot the host serves, overridable per test. */
function status(overrides: {
  platform?: string
  checkedAt?: number
  refreshStartedAt?: number | null
  listening?: boolean
  appRunning?: boolean
  missing?: readonly string[]
  mitmdump?: string | null
  token?: { present: boolean; harvestedAt: number | null; ageSec: number | null; stale: boolean }
} = {}): Record<string, unknown> {
  return {
    platform: overrides.platform ?? 'win32',
    checkedAt: overrides.checkedAt ?? 1_000_000,
    refreshStartedAt: overrides.refreshStartedAt ?? null,
    workbuddy: {
      relay: { port: 8787, listening: overrides.listening ?? true },
      app: { installed: true, running: overrides.appRunning ?? true },
    },
    copilot: {
      relay: { port: 8899, listening: overrides.listening ?? true },
      app: { installed: true, running: overrides.appRunning ?? true },
      token: overrides.token ?? { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
      missing: overrides.missing ?? [],
      mitmdump: overrides.mitmdump === undefined ? 'C:/python/Scripts/mitmdump.exe' : overrides.mitmdump,
    },
  }
}

/** One refresh-transcript payload the host serves. */
function transcripts(overrides: {
  transcriptText?: string
  spawnText?: string
  truncated?: boolean
} = {}): Record<string, unknown> {
  const tail = (path: string, text: string): Record<string, unknown> =>
    ({ path, text, truncated: overrides.truncated ?? false })
  return {
    transcript: tail('C:/probe/auto-refresh.log', overrides.transcriptText ?? '第 1 轮\n'),
    spawn: tail('C:/probe/auto-refresh.spawn.log', overrides.spawnText ?? ''),
  }
}

/** A JSON response carrying one payload. */
function json(body: unknown, status_ = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status_,
    headers: { 'content-type': 'application/json' },
  })
}

/** The three-route carrier: a double whose per-route answers each test replaces. */
interface Carrier {
  readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** @param route - the route to count. @returns how many requests reached it. */
  readonly calls: (route: string) => number
  /** @param route - the route whose answer to replace. @param answer - the new answer. */
  readonly answer: (route: string, answer: () => Promise<Response>) => void
}

/**
 * Build the carrier double.
 * @param answers - initial per-route answers; the rest answer a well-formed default.
 * @returns the carrier and its per-route helpers.
 */
function carrier(answers: Record<string, () => Promise<Response>> = {}): Carrier {
  const table: Record<string, () => Promise<Response>> = {
    [LOCAL_BRIDGE_STATUS_ROUTE]: () => Promise.resolve(json(status())),
    [LOCAL_BRIDGE_LOG_ROUTE]: () => Promise.resolve(json(transcripts())),
    [LOCAL_BRIDGE_REFRESH_ROUTE]: () => Promise.resolve(json({ started: true, refusal: null, logFile: null })),
    ...answers,
  }
  const fetcher = vi.fn((input: string | URL): Promise<Response> => {
    const answer = table[String(input)]
    if (answer === undefined) throw new Error(`unexpected route: ${String(input)}`)
    return answer()
  })
  return {
    fetcher,
    calls: route => fetcher.mock.calls.filter(call => String(call[0]) === route).length,
    answer: (route, answer) => { table[route] = answer },
  }
}

describe('parseStatusPayload', () => {
  it('accepts a well-formed snapshot', () => {
    const parsed = parseStatusPayload(status())
    expect(parsed).not.toBeNull()
    expect(parsed?.copilot.relay).toEqual({ port: 8899, listening: true })
    expect(parsed?.copilot.token.harvestedAt).toBe(940_000)
  })

  it('accepts an absent token', () => {
    const parsed = parseStatusPayload(status({
      token: { present: false, harvestedAt: null, ageSec: null, stale: true },
      mitmdump: null,
    }))
    expect(parsed?.copilot.token).toEqual({ present: false, harvestedAt: null, ageSec: null, stale: true })
    expect(parsed?.copilot.mitmdump).toBeNull()
  })

  it('drops a prerequisite code this build does not know', () => {
    // Version skew must not blank the checklist the rest of the payload fills.
    const parsed = parseStatusPayload(status({ missing: ['mitmdump', 'brand-new-requirement'] }))
    expect(parsed?.copilot.missing).toEqual(['mitmdump'])
  })

  it('rejects a payload missing any field the page renders', () => {
    expect(parseStatusPayload(null)).toBeNull()
    expect(parseStatusPayload('nope')).toBeNull()
    expect(parseStatusPayload([])).toBeNull()
    expect(parseStatusPayload({ ...status(), platform: 7 })).toBeNull()
    expect(parseStatusPayload({ ...status(), checkedAt: 'soon' })).toBeNull()
    expect(parseStatusPayload({ ...status(), refreshStartedAt: undefined })).toBeNull()
    expect(parseStatusPayload({ ...status(), workbuddy: undefined })).toBeNull()
    expect(parseStatusPayload({ ...status(), copilot: undefined })).toBeNull()
    const broken = status()
    const copilot = { ...broken['copilot'] as Record<string, unknown>, mitmdump: 5 }
    expect(parseStatusPayload({ ...broken, copilot })).toBeNull()
  })

  it('rejects a nested fact the page would render as garbage', () => {
    const base = status()
    const copilot = base['copilot'] as Record<string, unknown>
    const relay = copilot['relay'] as Record<string, unknown>
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, relay: { ...relay, listening: 'yes' } } })).toBeNull()
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, relay: undefined } })).toBeNull()
    const app = copilot['app'] as Record<string, unknown>
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, app: { ...app, running: 1 } } })).toBeNull()
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, app: undefined } })).toBeNull()
    const token = copilot['token'] as Record<string, unknown>
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, token: { ...token, stale: 'no' } } })).toBeNull()
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, token: { ...token, harvestedAt: 'soon' } } })).toBeNull()
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, token: undefined } })).toBeNull()
    expect(parseStatusPayload({ ...base, copilot: { ...copilot, missing: 'none' } })).toBeNull()
    const workbuddy = base['workbuddy'] as Record<string, unknown>
    expect(parseStatusPayload({ ...base, workbuddy: { ...workbuddy, relay: undefined } })).toBeNull()
    expect(parseStatusPayload({ ...base, workbuddy: { app: { installed: true, running: true } } })).toBeNull()
  })
})

describe('parseRefreshPayload', () => {
  it('accepts a started refresh and a coded refusal', () => {
    expect(parseRefreshPayload({ started: true, refusal: null, logFile: '/probe/auto-refresh.log' }))
      .toEqual({ started: true, refusal: null, logFile: '/probe/auto-refresh.log' })
    expect(parseRefreshPayload({ started: false, refusal: 'busy', logFile: null }))
      .toEqual({ started: false, refusal: 'busy', logFile: null })
  })

  it('rejects a refusal code this build does not know', () => {
    expect(parseRefreshPayload({ started: false, refusal: 'invented', logFile: null })).toBeNull()
    expect(parseRefreshPayload({ started: false, refusal: null, logFile: null }))
      .toEqual({ started: false, refusal: null, logFile: null })
  })

  it('rejects a payload missing any field the page renders', () => {
    expect(parseRefreshPayload(null)).toBeNull()
    expect(parseRefreshPayload({})).toBeNull()
    expect(parseRefreshPayload({ started: 'yes', refusal: null, logFile: null })).toBeNull()
    expect(parseRefreshPayload({ started: true, refusal: null, logFile: 5 })).toBeNull()
  })
})

describe('refreshInFlight', () => {
  it('reads a held lock with an older token as running', () => {
    const parsed = parseStatusPayload(status({
      refreshStartedAt: 1_000_000,
      token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
    }))
    expect(parsed).not.toBeNull()
    expect(refreshInFlight(parsed!)).toBe(true)
  })

  it('reads a token newer than the lock as finished', () => {
    const parsed = parseStatusPayload(status({
      refreshStartedAt: 1_000_000,
      token: { present: true, harvestedAt: 1_030_000, ageSec: 0, stale: false },
    }))
    expect(refreshInFlight(parsed!)).toBe(false)
  })

  it('reads a held lock with no token at all as running', () => {
    const parsed = parseStatusPayload(status({
      refreshStartedAt: 1_000_000,
      token: { present: false, harvestedAt: null, ageSec: null, stale: true },
    }))
    expect(refreshInFlight(parsed!)).toBe(true)
  })

  it('reads no lock as nothing running', () => {
    expect(refreshInFlight(parseStatusPayload(status())!)).toBe(false)
  })
})

describe('LocalBridgeController', () => {
  it('publishes the snapshot and the transcripts the host served', async () => {
    const { fetcher } = carrier()
    const controller = new LocalBridgeController(fetcher)
    await controller.load()

    expect(fetcher).toHaveBeenCalledWith(LOCAL_BRIDGE_STATUS_ROUTE, { headers: { accept: 'application/json' } })
    expect(fetcher).toHaveBeenCalledWith(LOCAL_BRIDGE_LOG_ROUTE, { headers: { accept: 'application/json' } })
    const state = controller.page.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.phase === 'ready' ? state.status.copilot.relay.port : null).toBe(8899)
    const logs = controller.logs.getSnapshot()
    expect(logs.phase === 'ready' ? logs.log.transcript.text : null).toBe('第 1 轮\n')
  })

  it('reads a refused response and a transport failure as the same failed state', async () => {
    const refused = new LocalBridgeController(() => Promise.resolve(new Response('', { status: 500 })))
    await refused.load()
    expect(refused.page.getSnapshot()).toEqual({ phase: 'failed' })
    // A host that cannot answer either read leaves both stores unusable, never
    // one of them stale.
    expect(refused.logs.getSnapshot()).toEqual({ phase: 'unavailable' })

    const unreachable = new LocalBridgeController(() => Promise.reject(new Error('offline')))
    await unreachable.load()
    expect(unreachable.page.getSnapshot()).toEqual({ phase: 'failed' })
    expect(unreachable.logs.getSnapshot()).toEqual({ phase: 'unavailable' })
  })

  it('reads an unusable payload as failed rather than rendering it', async () => {
    const controller = new LocalBridgeController(() => Promise.resolve(json({ platform: 'win32' })))
    await controller.load()
    expect(controller.page.getSnapshot()).toEqual({ phase: 'failed' })
    expect(controller.logs.getSnapshot()).toEqual({ phase: 'unavailable' })
  })

  it('keeps the newer read when two are in flight', async () => {
    let release: ((response: Response) => void) | undefined
    let firstCall = true
    const { fetcher, calls } = carrier({
      [LOCAL_BRIDGE_STATUS_ROUTE]: () => {
        if (!firstCall) return Promise.resolve(json(status({ listening: false })))
        firstCall = false
        return new Promise<Response>((resolve) => { release = resolve })
      },
    })
    const controller = new LocalBridgeController(fetcher)

    const first = controller.load()
    const second = controller.load()
    await second
    release?.(json(status({ listening: true })))
    await first

    const state = controller.page.getSnapshot()
    expect(state.phase).toBe('ready')
    // The first read settled last, and its answer was dropped rather than
    // overwriting the fresher one.
    expect(state.phase === 'ready' ? state.status.copilot.relay.listening : null).toBe(false)
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
  })

  it('polls while a refresh is in flight and stops once the token advances', async () => {
    vi.useFakeTimers()
    const { fetcher, calls, answer } = carrier({
      [LOCAL_BRIDGE_STATUS_ROUTE]: () => Promise.resolve(json(status({
        refreshStartedAt: 1_000_000,
        token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
      }))),
    })
    const controller = new LocalBridgeController(fetcher)

    await controller.load()
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(1)
    expect(calls(LOCAL_BRIDGE_LOG_ROUTE)).toBe(1)
    answer(LOCAL_BRIDGE_STATUS_ROUTE, () => Promise.resolve(json(status({
      refreshStartedAt: null,
      token: { present: true, harvestedAt: 1_030_000, ageSec: 0, stale: false },
    }))))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
    // Each poll reads the transcripts too, so the log stays live while the
    // attempt runs.
    expect(calls(LOCAL_BRIDGE_LOG_ROUTE)).toBe(2)
    // The settled read left nothing in flight, so no further read is queued.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
  })

  it('cancels a queued read when a newer one starts', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = carrier({
      [LOCAL_BRIDGE_STATUS_ROUTE]: () => Promise.resolve(json(status({
        refreshStartedAt: 1_000_000,
        token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
      }))),
    })
    const controller = new LocalBridgeController(fetcher)

    await controller.load()
    await controller.load()
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
    // Only the second read's poll survives; the first was cancelled, not stacked.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(3)
    controller.dispose()
  })

  it('stops polling and publishing once disposed', async () => {
    vi.useFakeTimers()
    let release: ((response: Response) => void) | undefined
    const { fetcher, calls, answer } = carrier({
      [LOCAL_BRIDGE_STATUS_ROUTE]: () => Promise.resolve(json(status({
        refreshStartedAt: 1_000_000,
        token: { present: false, harvestedAt: null, ageSec: null, stale: true },
      }))),
    })
    const controller = new LocalBridgeController(fetcher)
    await controller.load()

    answer(LOCAL_BRIDGE_STATUS_ROUTE, () => new Promise<Response>((resolve) => { release = resolve }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
    const settled = controller.page.getSnapshot()
    controller.dispose()
    release?.(json(status({ listening: false })))
    await vi.advanceTimersByTimeAsync(20_000)

    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(2)
    // The poll's status read never settled, so the transcripts behind it were
    // never re-read either.
    expect(calls(LOCAL_BRIDGE_LOG_ROUTE)).toBe(1)
    expect(controller.page.getSnapshot()).toEqual(settled)
  })

  it('keeps the newer transcript read when two are in flight', async () => {
    let releaseLog: ((response: Response) => void) | undefined
    let firstLog = true
    const { fetcher } = carrier({
      [LOCAL_BRIDGE_LOG_ROUTE]: () => {
        if (!firstLog) return Promise.resolve(json(transcripts({ transcriptText: 'newer\n' })))
        firstLog = false
        return new Promise<Response>((resolve) => { releaseLog = resolve })
      },
    })
    const controller = new LocalBridgeController(fetcher)

    const first = controller.load()
    await vi.waitFor(() => { expect(releaseLog).toBeDefined() })
    const second = controller.load()
    await second
    releaseLog?.(json(transcripts({ transcriptText: 'stale\n' })))
    await first

    const logs = controller.logs.getSnapshot()
    expect(logs.phase === 'ready' ? logs.log.transcript.text : null).toBe('newer\n')
  })

  it('drops a transcript read that settles after disposal', async () => {
    let releaseLog: ((response: Response) => void) | undefined
    const { fetcher, answer } = carrier()
    answer(LOCAL_BRIDGE_LOG_ROUTE, () => new Promise<Response>((resolve) => { releaseLog = resolve }))
    const controller = new LocalBridgeController(fetcher)

    const loading = controller.load()
    await vi.waitFor(() => { expect(releaseLog).toBeDefined() })
    controller.dispose()
    releaseLog?.(json(transcripts({ transcriptText: 'late\n' })))
    await loading

    // The store keeps its pre-read state: a settled read after disposal is
    // dropped rather than published into a page that no longer exists.
    expect(controller.logs.getSnapshot()).toEqual({ phase: 'loading' })
  })

  it('posts the refresh, then reads the state it left behind', async () => {
    const { fetcher, calls, answer } = carrier()
    answer(LOCAL_BRIDGE_REFRESH_ROUTE, () => Promise.resolve(json({
      started: true, refusal: null, logFile: '/probe/auto-refresh.log',
    })))
    const controller = new LocalBridgeController(fetcher)
    const outcome = await controller.refresh()

    expect(fetcher).toHaveBeenCalledWith(LOCAL_BRIDGE_REFRESH_ROUTE, { method: 'POST' })
    expect(outcome).toEqual({ started: true, refusal: null, logFile: '/probe/auto-refresh.log' })
    expect(controller.page.getSnapshot().phase).toBe('ready')
    expect(calls(LOCAL_BRIDGE_STATUS_ROUTE)).toBe(1)
  })

  it('reports a refused refresh request as no outcome', async () => {
    const refused = carrier({ [LOCAL_BRIDGE_REFRESH_ROUTE]: () => Promise.resolve(new Response('', { status: 500 })) })
    expect(await new LocalBridgeController(refused.fetcher).refresh()).toBeNull()

    const unreachable = carrier({ [LOCAL_BRIDGE_REFRESH_ROUTE]: () => Promise.reject(new Error('offline')) })
    expect(await new LocalBridgeController(unreachable.fetcher).refresh()).toBeNull()
  })

  it('reports an unusable refresh answer as no outcome', async () => {
    const { fetcher } = carrier({
      [LOCAL_BRIDGE_REFRESH_ROUTE]: () => Promise.resolve(json({ started: 'maybe' })),
    })
    expect(await new LocalBridgeController(fetcher).refresh()).toBeNull()
  })
})

describe('parseLogPayload', () => {
  it('accepts both tails', () => {
    expect(parseLogPayload(transcripts({ truncated: true }))).toMatchObject({
      transcript: { path: 'C:/probe/auto-refresh.log', text: '第 1 轮\n', truncated: true },
      spawn: { text: '' },
    })
  })

  it('rejects a payload missing either tail', () => {
    expect(parseLogPayload(null)).toBeNull()
    expect(parseLogPayload({})).toBeNull()
    expect(parseLogPayload({ transcript: transcripts()['transcript'] })).toBeNull()
    expect(parseLogPayload({
      transcript: { path: 'a', text: 'b', truncated: 'yes' },
      spawn: { path: 'a', text: 'b', truncated: false },
    })).toBeNull()
    expect(parseLogPayload({
      transcript: { path: 1, text: 'b', truncated: false },
      spawn: { path: 'a', text: 'b', truncated: false },
    })).toBeNull()
  })
})
