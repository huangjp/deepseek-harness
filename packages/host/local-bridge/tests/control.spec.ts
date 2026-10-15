/**
 * The local-bridge control plane over injectable preflight facts: the status
 * mapping both relay cards render, and every refusal a refresh request can meet
 * before the real chain — which changes the Windows system proxy and drives the
 * Copilot window — is reached.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalBridgeControl, type PreflightFacts } from '../src/control.ts'

let root: string | undefined
let bound: { port: number; close: () => Promise<void> } | undefined

afterEach(async () => {
  await bound?.close()
  bound = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

/** Bind one ephemeral loopback port and report it; the caller closes it. */
async function openPort(): Promise<{ port: number; close: () => Promise<void> }> {
  // A raw net.Server has no closeAllConnections, and close() waits for live
  // sockets: the probe under test leaves one, so the fixture destroys its own.
  const sockets = new Set<Socket>()
  const server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the probe fixture bound no port')
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** A port with nothing behind it: bound once, then released. */
async function closedPort(): Promise<number> {
  const released = await openPort()
  const port = released.port
  await released.close()
  return port
}

/** The harvest facts one probe answers, defaulted to "nothing available". */
interface HarvestInput {
  hasToken?: boolean
  harvestedAt?: string | null
  ageSec?: number | null
  stale?: boolean
  mitmdump?: string | null
  harvester?: string | null
  mitmRunning?: boolean
  upstreamProxyUp?: boolean
}

/** A preflight module over injectable facts, with the shipped defaults filled in. */
function preflightModule(options: {
  harvest?: HarvestInput
  apps?: Record<string, { installed: boolean; running: boolean }>
  ca?: { installed: boolean; notAfter: string | null }
  refresh?: { started: boolean; reason?: string; logFile?: string }
} = {}): PreflightFacts {
  const harvest = {
    hasToken: false,
    harvestedAt: null,
    ageSec: null,
    stale: true,
    mitmdump: null,
    harvester: null,
    mitmRunning: false,
    upstreamProxyUp: false,
    ...options.harvest,
  }
  return {
    detectHarvest: () => Promise.resolve(harvest),
    detectAllApps: () => Promise.resolve(options.apps ?? {}),
    detectCa: () => Promise.resolve(options.ca ?? { installed: false, notAfter: null }),
    refreshCopilotToken: () => Promise.resolve(options.refresh ?? { started: true, logFile: '/probe/auto-refresh.log' }),
    refreshLockMs: 240_000,
  }
}

/** The fixture harvest directory the control plane under test reads. */
interface Fixture {
  control: ReturnType<typeof createLocalBridgeControl>
  log: ReturnType<typeof vi.fn>
  /** Absolute path of the refresh script this fixture placed. */
  script: string
}

/**
 * Build one control plane over a fresh harvest directory.
 * @param module - the preflight facts to serve.
 * @param options - whether the refresh script exists, and the relay ports.
 * @returns the control plane, its log sink, and its script path.
 */
async function fixture(module: PreflightFacts, options: {
  /** `present` writes the script, `absent` leaves it out. */
  refreshScript?: 'present' | 'absent'
  workbuddyPort?: number
  copilotPort?: number
} = {}): Promise<Fixture> {
  root = await mkdtemp(join(tmpdir(), 'dsh-local-bridge-control-'))
  const script = join(root, 'refresh-token.ps1')
  if ((options.refreshScript ?? 'present') === 'present') await writeFile(script, '# fixture\n', 'utf8')
  const log = vi.fn()
  return {
    script,
    log,
    control: createLocalBridgeControl({
      loadPreflight: () => Promise.resolve(module),
      refreshScript: script,
      harvestDir: root,
      workbuddyPort: options.workbuddyPort ?? await closedPort(),
      copilotPort: options.copilotPort ?? await closedPort(),
      log,
    }),
  }
}

/** Write the refresh lock with one stamp into the fixture harvest directory. */
async function writeLock(stamp: number): Promise<void> {
  if (root === undefined) throw new Error('the fixture harvest directory is not ready')
  await writeFile(join(root, '.auto-refresh.lock'), String(stamp), 'utf8')
}

describe('local-bridge status', () => {
  it('maps listeners, applications, the token, and the unmet prerequisites', async () => {
    bound = await openPort()
    const harvested = '2026-10-14T03:51:50.000Z'
    const { control } = await fixture(preflightModule({
      harvest: { hasToken: true, harvestedAt: harvested, ageSec: 120, stale: false },
      apps: { workbuddy: { installed: true, running: true }, copilot: { installed: true, running: false } },
    }), { workbuddyPort: bound.port })

    const status = await control.status()
    expect(status.platform).toBe(process.platform)
    expect(status.workbuddy.relay).toEqual({ port: bound.port, listening: true })
    expect(status.workbuddy.app).toEqual({ installed: true, running: true })
    expect(status.copilot.relay.listening).toBe(false)
    expect(status.copilot.app).toEqual({ installed: true, running: false })
    expect(status.copilot.token).toEqual({
      present: true,
      harvestedAt: Date.parse(harvested),
      ageSec: 120,
      stale: false,
    })
    // Nothing on this machine supplies any of the four; the control plane
    // derives each code from its own fact rather than from preflight's prose.
    expect(status.copilot.missing).toEqual(['mitmdump', 'harvester', 'upstream-proxy', 'ca'])
    expect(status.copilot.mitmdump).toBeNull()
    expect(status.refreshStartedAt).toBeNull()
  })

  it('reports an unreadable token timestamp as absent rather than as NaN', async () => {
    const { control } = await fixture(preflightModule({
      harvest: { hasToken: true, harvestedAt: 'not-a-timestamp', ageSec: 5 },
    }))
    expect((await control.status()).copilot.token.harvestedAt).toBeNull()
  })

  it('reports no unmet prerequisite once every fact is present', async () => {
    const { control } = await fixture(preflightModule({
      harvest: {
        mitmdump: 'C:/python/Scripts/mitmdump.exe',
        harvester: 'C:/probe/token-harvester.py',
        upstreamProxyUp: true,
      },
      ca: { installed: true, notAfter: '2030-01-01' },
    }))
    const status = await control.status()
    expect(status.copilot.missing).toEqual([])
    expect(status.copilot.mitmdump).toBe('C:/python/Scripts/mitmdump.exe')
  })

  it('reports a held refresh lock and drops an expired one', async () => {
    const { control } = await fixture(preflightModule())
    await writeLock(Date.now())
    expect((await control.status()).refreshStartedAt).toBeGreaterThan(0)
    await writeLock(Date.now() - 240_001)
    expect((await control.status()).refreshStartedAt).toBeNull()
  })

  it('ignores a lock file whose content is not a stamp', async () => {
    const { control } = await fixture(preflightModule())
    await writeLock(Number.NaN)
    expect((await control.status()).refreshStartedAt).toBeNull()
  })
})

describe('local-bridge refresh', () => {
  it('refuses off Windows before loading the relay runtime at all', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const loadPreflight = vi.fn(() => { throw new Error('the runtime must not load') })
    root = await mkdtemp(join(tmpdir(), 'dsh-local-bridge-control-'))
    const control = createLocalBridgeControl({
      loadPreflight,
      refreshScript: join(root, 'refresh-token.ps1'),
      harvestDir: root,
      workbuddyPort: 8787,
      copilotPort: 8899,
      log: vi.fn(),
    })
    expect(await control.refresh()).toEqual({ started: false, refusal: 'unsupported-platform', logFile: null })
    expect(loadPreflight).not.toHaveBeenCalled()
  })

  it('refuses while an earlier attempt still holds the lock', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(preflightModule())
    await writeLock(Date.now())
    expect(await control.refresh()).toEqual({ started: false, refusal: 'busy', logFile: null })
  })

  it('refuses when the refresh script is not on disk', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(preflightModule(), { refreshScript: 'absent' })
    expect(await control.refresh()).toEqual({ started: false, refusal: 'script-missing', logFile: null })
  })

  it('refuses while the Copilot desktop application is not running', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(preflightModule({
      apps: { copilot: { installed: true, running: false } },
    }))
    expect(await control.refresh()).toEqual({ started: false, refusal: 'copilot-not-running', logFile: null })
  })

  it('refuses while a prerequisite is unmet', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(preflightModule({
      apps: { copilot: { installed: true, running: true } },
    }))
    expect(await control.refresh()).toEqual({ started: false, refusal: 'prerequisites-missing', logFile: null })
  })

  it('reports a process that would not start, logging the operator reason', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control, log } = await fixture(preflightModule({
      harvest: { mitmdump: 'mitmdump', harvester: 'harvester', upstreamProxyUp: true },
      ca: { installed: true, notAfter: null },
      apps: { copilot: { installed: true, running: true } },
      refresh: { started: false, reason: '锁文件不可用：EACCES' },
    }))
    expect(await control.refresh()).toEqual({ started: false, refusal: 'spawn-failed', logFile: null })
    expect(log).toHaveBeenCalledWith('local-bridge: token refresh did not start: 锁文件不可用：EACCES')
  })

  it('names an unstated cause when the runtime refuses without one', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control, log } = await fixture(preflightModule({
      harvest: { mitmdump: 'mitmdump', harvester: 'harvester', upstreamProxyUp: true },
      ca: { installed: true, notAfter: null },
      apps: { copilot: { installed: true, running: true } },
      refresh: { started: false },
    }))
    expect(await control.refresh()).toEqual({ started: false, refusal: 'spawn-failed', logFile: null })
    expect(log).toHaveBeenCalledWith('local-bridge: token refresh did not start: unknown')
  })

  it('starts the refresh and returns its transcript path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(readyPreflight())
    expect(await control.refresh()).toEqual({
      started: true,
      refusal: null,
      logFile: '/probe/auto-refresh.log',
    })
  })

  it('starts without a transcript path when the runtime reports none', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { control } = await fixture(readyPreflight({ started: true }))
    expect((await control.refresh()).logFile).toBeNull()
  })
})

/** A machine where every refresh precondition is already met. */
function readyPreflight(refresh?: { started: boolean; reason?: string; logFile?: string }): PreflightFacts {
  return preflightModule({
    harvest: { mitmdump: 'mitmdump', harvester: 'harvester', upstreamProxyUp: true },
    ca: { installed: true, notAfter: null },
    apps: { copilot: { installed: true, running: true } },
    ...refresh === undefined ? {} : { refresh },
  })
}
