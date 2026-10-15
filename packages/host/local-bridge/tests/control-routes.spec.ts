/**
 * The local-bridge control-plane routes over a real WebServer booted through
 * the vendored Loader (the REAL-composition requirement), asserting the HTTP
 * surface: the connection trust fence, each route's one method, and the
 * responses the settings page reads.
 *
 * The relay runtime is replaced through the package `internals` seam, and the
 * relays stay disabled, so no bridge process starts and no refresh chain — which
 * would change the Windows system proxy — can run. The filesystem is real.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as LocalBridge from '../src/index.ts'
import { internals } from '../src/internals.ts'

let root: string | undefined
let context: Context | undefined
/** The rejection the connection stub gives every route until a test changes it. */
const trust: { rejection: 401 | 403 | undefined } = { rejection: undefined }

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  internals.preflight = undefined
  trust.rejection = undefined
  vi.restoreAllMocks()
})

/**
 * The module namespace the plugin loads instead of `bridge/preflight.mjs`.
 * @param options - the refresh outcome to serve.
 * @returns the namespace.
 */
function preflightModule(options: {
  refresh?: { started: boolean; reason?: string; logFile?: string }
} = {}): Record<string, unknown> {
  return {
    detectHarvest: () => Promise.resolve({
      hasToken: true,
      harvestedAt: '2026-10-14T03:51:50.000Z',
      ageSec: 30,
      stale: false,
      mitmdump: 'mitmdump',
      harvester: 'harvester',
      mitmRunning: true,
      upstreamProxyUp: true,
    }),
    detectAllApps: () => Promise.resolve({
      workbuddy: { installed: true, running: true },
      copilot: { installed: true, running: true },
    }),
    detectCa: () => Promise.resolve({ installed: true, notAfter: '2030-01-01' }),
    refreshCopilotToken: () => Promise.resolve(options.refresh ?? { started: true, logFile: '/probe/auto-refresh.log' }),
    REFRESH_LOCK_MS: 240_000,
    REFRESH_LOG_FILES: { transcript: 'auto-refresh.log', spawn: 'auto-refresh.spawn.log' },
  }
}

/**
 * Boot webserver + local-bridge rows through the real Loader.
 * @param options - whether the composition carries a connection trust fence, and a log sink.
 * @returns the server's base URL.
 */
async function boot(options: { trust?: boolean; logs?: string[] } = {}): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-local-bridge-routes-'))
  const harvest = join(root, 'harvest')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-local-bridge'",
    '  config:',
    '    enabled: false',
    "    host: '127.0.0.1'",
    '    port: 8787',
    '    backend: serve',
    "    cacheDir: ''",
    '    copilot:',
    '      enabled: false',
    '      port: 8899',
    `      harvestDir: '${harvest}'`,
    '    deps:',
    '      autoStart: false',
    '      autoRefreshToken: false',
    '      bootstrap: false',
    '      autoInstallCa: false',
    '      autoInstallMitm: false',
    '',
  ].join('\n'))

  internals.preflight = () => Promise.resolve(preflightModule())
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  if (options.logs !== undefined) {
    const lines = options.logs
    context.logger.exporter({
      // A default exporter receives `error` and `info` only; the control plane's
      // refusals are `warn`, so this sink raises its threshold to collect them.
      levels: { default: 2 },
      export(message) { lines.push(message.args.map(entry => String(entry)).join(' ')) },
    })
  }
  if (options.trust !== false) {
    context.provide('connection', { requestRejection: () => trust.rejection } as never)
  }
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-host-local-bridge', LocalBridge],
  ])
  // Installed through Object.assign so the double needs no assertion to the
  // vendored loader's opaque internal-module union: the entries below are
  // resolved from these two modules instead of from an installed lib/.
  Object.assign(context.loader, {
    internal: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

describe('local-bridge control routes', () => {
  it('keeps the function-plugin runtime surface to Loader exports', () => {
    expect(Object.keys(LocalBridge).sort()).toEqual(['Config', 'apply', 'name', 'resolveRealPath'])
  })

  it('answers the connection rejection on both routes before any probe runs', async () => {
    const probe = vi.fn(() => Promise.resolve(preflightModule()))
    const base = await boot()
    internals.preflight = probe
    trust.rejection = 403
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(403)
    expect((await fetch(`${base}/local-bridge/refresh`, { method: 'POST' })).status).toBe(403)
    expect(probe).not.toHaveBeenCalled()
    trust.rejection = 401
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(401)
    trust.rejection = undefined
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(200)
  })

  it('serves one status snapshot with no caching', async () => {
    const base = await boot()
    const response = await fetch(`${base}/local-bridge/status`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const payload = await response.json() as {
      platform: string
      workbuddy: { relay: { port: number; listening: boolean } }
      copilot: { token: { stale: boolean }; missing: readonly string[] }
      refreshStartedAt: number | null
    }
    expect(payload.platform).toBe(process.platform)
    // The listener facts themselves belong to the control-plane spec, which
    // binds and releases real ports; a route test cannot assert what this
    // machine happens to have listening on the shipped relay ports.
    expect(payload.workbuddy.relay.port).toBe(8787)
    expect(payload.copilot.token.stale).toBe(false)
    expect(payload.copilot.missing).toEqual([])
    expect(payload.refreshStartedAt).toBeNull()
  })

  it('answers each route only on its own method', async () => {
    const base = await boot()
    const posted = await fetch(`${base}/local-bridge/status`, { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET')
    const fetched = await fetch(`${base}/local-bridge/refresh`)
    expect(fetched.status).toBe(405)
    expect(fetched.headers.get('allow')).toBe('POST')
  })

  it('refuses a refresh on a platform that cannot run the chain', async () => {
    // The chain is Windows-only; forcing the other platform exercises the
    // refusal every non-Windows deployment meets.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const base = await boot()
    const response = await fetch(`${base}/local-bridge/refresh`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      started: false,
      refusal: 'unsupported-platform',
      logFile: null,
    })
  })

  it('grants a refresh on a machine whose prerequisites are met', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const base = await boot()
    const response = await fetch(`${base}/local-bridge/refresh`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      started: true,
      refusal: null,
      logFile: '/probe/auto-refresh.log',
    })
  })

  it('reports a refresh the runtime refused, and logs the reason it gave', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const logged: string[] = []
    const base = await boot({ logs: logged })
    internals.preflight = () => Promise.resolve(preflightModule({
      refresh: { started: false, reason: '锁文件不可用：EACCES' },
    }))

    const response = await fetch(`${base}/local-bridge/refresh`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ started: false, refusal: 'spawn-failed', logFile: null })
    expect(logged.join('\n')).toContain('锁文件不可用：EACCES')
  })

  it('serves the refresh transcripts the harvest directory holds', async () => {
    const base = await boot()
    const harvest = join(root!, 'harvest')
    await mkdir(harvest, { recursive: true })
    await writeFile(join(harvest, 'auto-refresh.spawn.log'), 'PowerShell 退出：code=1\n', 'utf8')
    const response = await fetch(`${base}/local-bridge/log`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const payload = await response.json() as {
      transcript: { path: string; text: string; truncated: boolean }
      spawn: { text: string }
    }
    // The attempt never wrote a transcript, and that absence is a fact the page
    // shows rather than an error.
    expect(payload.transcript.text).toBe('')
    expect(payload.transcript.truncated).toBe(false)
    expect(payload.transcript.path.endsWith('auto-refresh.log')).toBe(true)
    expect(payload.spawn.text).toBe('PowerShell 退出：code=1\n')
  })

  it('answers the log route only on GET, behind the same trust fence', async () => {
    const base = await boot()
    const posted = await fetch(`${base}/local-bridge/log`, { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET')
    trust.rejection = 403
    expect((await fetch(`${base}/local-bridge/log`)).status).toBe(403)
  })

  it('answers a status read with the webserver refusal when the runtime cannot supply it', async () => {
    const base = await boot()
    // A runtime module missing the control exports is a broken deployment; the
    // route fails rather than reporting an empty machine.
    internals.preflight = () => Promise.resolve({})

    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(400)
  })

  it('registers no route when the composition carries no trust fence', async () => {
    const base = await boot({ trust: false })
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(404)
    expect((await fetch(`${base}/local-bridge/refresh`, { method: 'POST' })).status).toBe(404)
  })
})
