/**
 * The relay lifecycle the plugin owns: with `enabled` true it starts the
 * configured relays, reports what the boot preflight found, keeps the host
 * mounted when that preflight contributes nothing, fails, or is not shipped at
 * all, and closes every listener again on disposal.
 *
 * The relay runtimes are the shipped `bridge/*.mjs`, so this boots real HTTP
 * listeners on ports the spec acquires and releases. The dependency preflight is
 * replaced through the package `internals` seam except where a test is about the
 * shipped module itself, so no desktop application, certificate, or proxy is
 * touched.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as LocalBridge from '../src/index.ts'
import { internals } from '../src/internals.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  internals.preflight = undefined
})

/** Bind one ephemeral loopback port and report it; the caller closes it. */
async function openPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture bound no port')
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** A port with nothing behind it: bound once, then released for a relay. */
async function freePort(): Promise<number> {
  const released = await openPort()
  const port = released.port
  await released.close()
  return port
}

/** Whether something accepts a connection on one loopback port now. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value: boolean): void => { socket.destroy(); resolve(value) }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/** The control-plane exports every module namespace must carry. */
const CONTROL_EXPORTS = {
  detectHarvest: () => Promise.resolve({
    hasToken: false, harvestedAt: null, ageSec: null, stale: true,
    mitmdump: null, harvester: null, mitmRunning: false, upstreamProxyUp: false,
  }),
  detectAllApps: () => Promise.resolve({}),
  detectCa: () => Promise.resolve({ installed: false, notAfter: null }),
  refreshCopilotToken: () => Promise.resolve({ started: false }),
  REFRESH_LOCK_MS: 240_000,
  REFRESH_LOG_FILES: { transcript: 'auto-refresh.log', spawn: 'auto-refresh.spawn.log' },
}

/**
 * A boot preflight report.
 * @param overrides - fields to replace in the complete report.
 * @returns the report, written the way `bridge/preflight.mjs` writes it.
 */
function bootReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootstrap: { copied: ['refresh-token.ps1'], repaired: ['token-harvester.py'], skipped: [] },
    apps: {
      started: { label: 'Started App', installed: true, running: true, started: true },
      running: { label: 'Running App', installed: true, running: true, started: false },
      stopped: { label: 'Stopped App', installed: true, running: false, started: false },
      absent: { label: 'Absent App', installed: false, running: false, started: false },
    },
    ca: { installed: false },
    mitmInstall: { started: false, reason: '未找到 Python' },
    ...overrides,
  }
}

/**
 * The module namespace the plugin loads instead of `bridge/preflight.mjs`.
 * @param options - the boot preflight's report, its failure, or its absence.
 * @returns the namespace.
 */
function preflightModule(options: {
  /** What `runPreflight` resolves; `null` rejects, and `false` removes the export. */
  report?: Record<string, unknown> | null | false
} = {}): Record<string, unknown> {
  const report = options.report === undefined ? bootReport() : options.report
  if (report === false) return { ...CONTROL_EXPORTS }
  return {
    ...CONTROL_EXPORTS,
    runPreflight: (settings: Record<string, unknown>) => {
      // The shipped preflight reports progress through the callback the plugin
      // hands it; a double that never calls it would leave that path unproven.
      const log = settings['log']
      if (typeof log === 'function') (log as (message: string) => void)('预检进行中')
      return report === null
        ? Promise.reject(new Error('预检模块自身失败'))
        : Promise.resolve(report)
    },
  }
}

/** What one boot needs beyond the module namespace. */
interface BootOptions {
  /** WorkBuddy relay port. */
  workbuddy: number
  /** Copilot relay port, or undefined to leave the Copilot relay disabled. */
  copilot?: number
  /** Copilot harvest directory; absent writes an empty one into the config. */
  harvestDir?: string
  /** Module namespace to serve; absent loads the shipped `bridge/preflight.mjs`. */
  module?: Record<string, unknown>
  /** Receives every message the composition's logger exports. */
  logs?: string[]
}

/**
 * Boot webserver + local-bridge with the relays enabled.
 * @param options - relay ports, harvest directory, module namespace, and log sink.
 * @returns the webserver's base URL.
 */
async function boot(options: BootOptions): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-local-bridge-relay-'))
  const configPath = join(root, 'cordis.yml')
  const copilot = options.copilot === undefined
    ? ['    copilot:', '      enabled: false', '      port: 8899']
    : [
      '    copilot:',
      '      enabled: true',
      `      port: ${String(options.copilot)}`,
      `      harvestDir: '${options.harvestDir ?? ''}'`,
    ]
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-local-bridge'",
    '  config:',
    '    enabled: true',
    "    host: '127.0.0.1'",
    `    port: ${String(options.workbuddy)}`,
    '    backend: serve',
    `    cacheDir: '${join(root, 'cache')}'`,
    ...copilot,
    '    deps:',
    '      autoStart: false',
    '      autoRefreshToken: false',
    '      bootstrap: false',
    '      autoInstallCa: false',
    '      autoInstallMitm: false',
    '',
  ].join('\n'))

  const served = options.module
  if (served !== undefined) internals.preflight = () => Promise.resolve(served)
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  if (options.logs !== undefined) {
    const lines = options.logs
    context.logger.exporter({
      // A default exporter receives `error` and `info` only; the plugin's
      // degraded-state reports are `warn`, so this sink raises its threshold to
      // Cordis' WARN severity to collect them.
      levels: { default: 2 },
      export(message) { lines.push(message.args.map(entry => String(entry)).join(' ')) },
    })
  }
  context.provide('connection', { requestRejection: () => undefined } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-host-local-bridge', LocalBridge],
  ])
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
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

describe('local-bridge relay lifecycle', () => {
  it('starts both relays, reports them, and closes them on disposal', async () => {
    const logs: string[] = []
    const workbuddy = await freePort()
    const copilot = await freePort()
    await boot({
      workbuddy,
      copilot,
      harvestDir: join(tmpdir(), 'dsh-local-bridge-harvest-fixture'),
      module: preflightModule(),
      logs,
    })
    // `startBridge` reports only after the listener is bound, and the plugin's
    // mount settles before that, so each port is awaited rather than assumed.
    await expect.poll(() => listening(workbuddy), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => listening(copilot), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 }).toContain('WorkBuddy 模型反代 已监听')
    expect(logs.join('\n')).toContain('Microsoft Copilot 反代 已监听')

    await context?.fiber.dispose()
    context = undefined
    await expect.poll(() => listening(workbuddy), { timeout: 15_000 }).toBe(false)
    await expect.poll(() => listening(copilot), { timeout: 15_000 }).toBe(false)
  })

  it('starts the Copilot relay without a harvest directory configured', async () => {
    const copilot = await freePort()
    await boot({ workbuddy: await freePort(), copilot, module: preflightModule() })
    await expect.poll(() => listening(copilot), { timeout: 15_000 }).toBe(true)
  })

  it('starts only the relay the composition enables', async () => {
    const logs: string[] = []
    await boot({ workbuddy: await freePort(), module: preflightModule(), logs })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 }).toContain('WorkBuddy 模型反代 已监听')
    expect(logs.join('\n')).not.toContain('Microsoft Copilot 反代 已监听')
  })

  it('summarizes the deployment files the preflight wrote', async () => {
    const logs: string[] = []
    await boot({ workbuddy: await freePort(), module: preflightModule(), logs })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('已自举部署文件：新增 1 个、修复 1 个')
    // The preflight's own progress callback reached the logger too.
    expect(logs.join('\n')).toContain('预检进行中')
  })

  it('reports a deployment file it had to repair without any new copy', async () => {
    const logs: string[] = []
    await boot({
      workbuddy: await freePort(),
      module: preflightModule({ report: bootReport({ bootstrap: { repaired: ['x.ps1'] } }) }),
      logs,
    })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('已自举部署文件：新增 0 个、修复 1 个')
  })

  it('reports a newly deployed file beside no repair at all', async () => {
    const logs: string[] = []
    await boot({
      workbuddy: await freePort(),
      module: preflightModule({ report: bootReport({ bootstrap: { copied: ['x.ps1'] } }) }),
      logs,
    })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('已自举部署文件：新增 1 个、修复 0 个')
  })

  it('reports neither a deployment summary nor degraded prerequisites when none exist', async () => {
    const logs: string[] = []
    await boot({
      workbuddy: await freePort(),
      module: preflightModule({ report: { bootstrap: {}, ca: { installed: true }, mitmInstall: { started: true } } }),
      logs,
    })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 }).toContain('预检进行中')
    expect(logs.join('\n')).not.toContain('已自举部署文件')
    expect(logs.join('\n')).not.toContain('CA 未装入受信任根证书区')
    expect(logs.join('\n')).not.toContain('mitmproxy 未就绪')
  })

  it('reports the degraded prerequisites a preflight found', async () => {
    const logs: string[] = []
    await boot({ workbuddy: await freePort(), module: preflightModule(), logs })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('CA 未装入受信任根证书区')
    expect(logs.join('\n')).toContain('mitmproxy 未就绪：未找到 Python')
  })

  it('reports each companion application by the state it was found in', async () => {
    const logs: string[] = []
    await boot({ workbuddy: await freePort(), module: preflightModule(), logs })
    // The application rows report in one pass, so the last one is what proves
    // the whole set arrived.
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('Absent App：未检测到（未安装）')
    expect(logs.join('\n')).toContain('Started App：已自动启动')
    expect(logs.join('\n')).toContain('Running App：运行中')
    expect(logs.join('\n')).toContain('Stopped App：已安装但未运行')
  })

  it('mounts the host when the relay runtime has no boot entry', async () => {
    const logs: string[] = []
    // The boot preflight is optional work: a runtime module that cannot run it
    // must cost its own report, never the relays themselves.
    const base = await boot({ workbuddy: await freePort(), module: preflightModule({ report: false }), logs })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 }).toContain('依赖预检失败')
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(200)
  })

  it('mounts the host when the boot preflight itself fails', async () => {
    const logs: string[] = []
    const base = await boot({ workbuddy: await freePort(), module: preflightModule({ report: null }), logs })
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 }).toContain('预检模块自身失败')
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(200)
  })

  it('keeps the other relay up when one relay cannot bind', async () => {
    const logs: string[] = []
    const occupied = await openPort()
    const copilot = await freePort()
    const base = await boot({ workbuddy: occupied.port, copilot, module: preflightModule(), logs })
    // Both relays start in one pass, and the Copilot relay is the later of the
    // two, so its line is what proves the first one's failure was contained.
    await expect.poll(() => logs.join('\n'), { timeout: 15_000 })
      .toContain('Microsoft Copilot 反代 已监听')
    expect(logs.join('\n')).toContain('WorkBuddy 模型反代 启动失败')
    expect((await fetch(`${base}/local-bridge/status`)).status).toBe(200)
    await occupied.close()
  })

  it('reads the shipped relay runtime when no test double is installed', async () => {
    const base = await boot({ workbuddy: await freePort() })
    // This is the only check that the published `bridge/preflight.mjs` really
    // exports what the control plane validates; the answers themselves describe
    // whatever machine runs the suite, so only their presence is asserted.
    const response = await fetch(`${base}/local-bridge/status`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { platform?: unknown; copilot?: { missing?: unknown } }
    expect(typeof payload.platform).toBe('string')
    expect(Array.isArray(payload.copilot?.missing)).toBe(true)
    // The real probes spawn `tasklist` and PowerShell, which outlast the
    // default per-test budget when the suite runs beside every other lane.
  }, 60_000)
})
