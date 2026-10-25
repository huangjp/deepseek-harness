/**
 * Control plane over the two bundled relays: one status snapshot of the
 * WorkBuddy and Copilot relays, and the trigger for a Copilot token refresh.
 *
 * The refresh chain itself lives in `bridge/preflight.mjs` and
 * `bridge/refresh-token.ps1`, which the host's boot preflight already runs.
 * This module reads only the facts those own and decides only what the wire
 * contract owns: which prerequisite codes are unmet, and whether a refresh may
 * start now. It never restates the operator prose preflight writes for its log.
 *
 * @module @deepseek-ai/dsh-host-local-bridge/control
 */

import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import type {
  LocalBridgeAppStatus,
  LocalBridgeCookieStatus,
  LocalBridgeCopilotStatus,
  LocalBridgeLogPayload,
  LocalBridgePrerequisite,
  LocalBridgeRefreshPayload,
  LocalBridgeRefreshRefusal,
  LocalBridgeStatusPayload,
  LocalBridgeTokenStatus,
  LocalBridgeTranscript,
} from './shared.ts'

/**
 * Loopback connect deadline for one relay or proxy probe. A robustness bound of
 * the probe protocol rather than a deployment choice: the targets are on
 * 127.0.0.1 and answer in microseconds, so the deadline only distinguishes
 * "listening" from "nothing is there", and it matches the probe
 * `bridge/preflight.mjs` runs for the same ports.
 */
const PORT_PROBE_TIMEOUT_MS = 800

/**
 * How much of each refresh transcript the page receives. A bound of the read
 * protocol rather than a deployment choice: the transcript is rewritten by
 * every attempt, while the spawn trace appends to one file forever, so this is
 * what keeps a long-lived harvest directory from being shipped to the browser.
 * It is far larger than one attempt writes.
 */
const LOG_TAIL_BYTES = 16 * 1024

/** The subset of `bridge/preflight.mjs` this control plane reads. */
export interface PreflightFacts {
  /** @param harvestDir - harvest directory. @param options - probe overrides. @returns the harvest facts. */
  detectHarvest(harvestDir: string, options?: Record<string, unknown>): Promise<{
    hasToken: boolean
    harvestedAt: string | null
    ageSec: number | null
    stale: boolean
    mitmdump: string | null
    harvester: string | null
    mitmRunning: boolean
    upstreamProxyUp: boolean
  }>
  /** @returns both companion applications' detection results, keyed by kind. */
  detectAllApps(): Promise<Record<string, { installed: boolean; running: boolean }>>
  /** @returns whether the interception certificate is trusted. */
  detectCa(): Promise<{ installed: boolean; notAfter: string | null }>
  /** @param options - script and harvest paths. @returns whether a refresh process started. */
  refreshCopilotToken(options: { scriptPath: string; harvestDir: string }): Promise<{
    started: boolean
    reason?: string
    logFile?: string
  }>
  /** Concurrency window a refresh attempt holds its lock for, in milliseconds. */
  refreshLockMs: number
  /** The two transcript filenames one attempt writes into the harvest directory. */
  refreshLogFiles: { transcript: string; spawn: string }
}

/** Paths and ports the control plane reads from the composition. */
export interface LocalBridgeControlOptions {
  /**
   * Loads the relay runtime module. Injected so a test can drive the control
   * plane without a harvest directory, a desktop application, or a process
   * spawn; the host passes the computed `bridge/preflight.mjs` URL.
   */
  readonly loadPreflight: () => Promise<PreflightFacts>
  /** Absolute path of `bridge/refresh-token.ps1`, outside any ASAR archive. */
  readonly refreshScript: string
  /** Directory holding the harvested token, template, and refresh transcripts. */
  readonly harvestDir: string
  /** WorkBuddy relay port. */
  readonly workbuddyPort: number
  /** Copilot relay port. */
  readonly copilotPort: number
  /** Huawei Celia relay port. */
  readonly xiaoyiPort: number
  /** Receives the operator prose preflight returns, which the wire never carries. */
  readonly log: (message: string) => void
}

/** The status read and refresh trigger the local-bridge routes serve. */
export interface LocalBridgeControl {
  /** @returns one snapshot of both relays, the token, and the refresh prerequisites. */
  status(): Promise<LocalBridgeStatusPayload>
  /** @returns whether a refresh process started, and why not when it did not. */
  refresh(): Promise<LocalBridgeRefreshPayload>
  /** @returns the tails of both refresh transcripts the last attempt wrote. */
  log(): Promise<LocalBridgeLogPayload>
}

/**
 * Read one file's tail as text.
 *
 * A cut can land inside a character or a line, so the bytes are decoded
 * leniently and, when the read started mid-file, everything before the first
 * line break is dropped. The caller is told the file held more.
 * @param path - absolute path of the file to read.
 * @returns the tail's text and whether the file held more than it carries.
 */
async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    // Absent, or unreadable: an attempt that never wrote a transcript simply
    // has nothing to show, which is not a failure of the read.
    return { text: '', truncated: false }
  }
  try {
    const size = (await handle.stat()).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const length = size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const decoded = buffer.toString('utf8')
    const breakAt = decoded.indexOf('\n')
    return {
      text: start === 0 || breakAt < 0 ? decoded : decoded.slice(breakAt + 1),
      truncated: start > 0,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Read both transcripts one refresh attempt writes.
 * @param harvestDir - directory the attempt writes them into.
 * @param files - the filenames `bridge/preflight.mjs` owns.
 * @returns one payload carrying both tails and their absolute paths.
 */
async function readLogs(
  harvestDir: string,
  files: { transcript: string; spawn: string },
): Promise<LocalBridgeLogPayload> {
  const transcriptPath = join(harvestDir, files.transcript)
  const spawnPath = join(harvestDir, files.spawn)
  const [transcript, spawn] = await Promise.all([readTail(transcriptPath), readTail(spawnPath)])
  const tail = (path: string, read: { text: string; truncated: boolean }): LocalBridgeTranscript =>
    ({ path, ...read })
  return { transcript: tail(transcriptPath, transcript), spawn: tail(spawnPath, spawn) }
}

/** Whether a TCP connect to one loopback port succeeds within the probe deadline. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    /* v8 ignore next -- a loopback connect is accepted or refused at once; the deadline only guards a hang no fixture can stage */
    const timer = setTimeout(() => { done(false) }, PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => { clearTimeout(timer); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
  })
}

/** One relay's listener as the port probe found it. */
async function relayStatus(port: number): Promise<LocalBridgeStatusPayload['workbuddy']['relay']> {
  return { port, listening: await probePort(port) }
}

/**
 * Loopback deadline for reading one relay's own health response. The target is
 * on 127.0.0.1 and answers in microseconds, so the deadline only keeps a
 * stalled relay from holding the status read open.
 */
const RELAY_HEALTH_TIMEOUT_MS = 2000

/** The cookie facts of a Celia relay that did not answer. */
const ABSENT_COOKIE: LocalBridgeCookieStatus = {
  present: false,
  harvestedAt: null,
  ageSec: null,
  missing: [],
}

/**
 * The Celia relay's credential facts, as its own health response reports them.
 *
 * The relay owns the credential cache, so the control plane asks the relay
 * instead of reading that cache file itself: a second reader would have to
 * know the file's path and shape, and would drift from the relay writing it.
 *
 * @param port - the Celia relay's loopback port.
 * @returns the cookie facts, or the absent facts when the relay did not answer.
 */
async function readXiaoyiCookie(port: number): Promise<LocalBridgeCookieStatus> {
  const ctl = new AbortController()
  const timer = setTimeout(() => { ctl.abort() }, RELAY_HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal })
    if (!res.ok) return ABSENT_COOKIE
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return ABSENT_COOKIE
    const record = body as Record<string, unknown>
    const savedAt = record['savedAt']
    const ageHours = record['ageHours']
    const missing = record['missing']
    return {
      present: record['token'] === 'cached',
      harvestedAt: typeof savedAt === 'number' ? savedAt : null,
      ageSec: typeof ageHours === 'number' ? Math.round(ageHours * 3600) : null,
      missing: Array.isArray(missing)
        ? missing.filter((name): name is string => typeof name === 'string')
        : [],
    }
  } catch {
    // The relay did not answer. Its listener probe already reports that, and
    // this status says the same thing about the cookie.
    return ABSENT_COOKIE
  } finally {
    clearTimeout(timer)
  }
}

/** Normalize one detection result, whose absence reads as unavailable. */
function appStatus(facts: { installed: boolean; running: boolean } | undefined): LocalBridgeAppStatus {
  return { installed: facts?.installed ?? false, running: facts?.running ?? false }
}

/** The token's age as the harvest facts state it. */
function tokenStatus(facts: {
  hasToken: boolean
  harvestedAt: string | null
  ageSec: number | null
  stale: boolean
}): LocalBridgeTokenStatus {
  const harvestedAtMs = facts.harvestedAt === null ? Number.NaN : Date.parse(facts.harvestedAt)
  return {
    present: facts.hasToken,
    harvestedAt: Number.isFinite(harvestedAtMs) ? harvestedAtMs : null,
    ageSec: facts.ageSec,
    stale: facts.stale,
  }
}

/** Unmet prerequisites, derived from the facts their owners report. */
function missingPrerequisites(
  harvest: { mitmdump: string | null; harvester: string | null; upstreamProxyUp: boolean },
  caInstalled: boolean,
): LocalBridgePrerequisite[] {
  const missing: LocalBridgePrerequisite[] = []
  if (harvest.mitmdump === null) missing.push('mitmdump')
  if (harvest.harvester === null) missing.push('harvester')
  if (!harvest.upstreamProxyUp) missing.push('upstream-proxy')
  if (!caInstalled) missing.push('ca')
  return missing
}

/**
 * Build the control plane one local-bridge mount serves.
 * @param options - the relay runtime loader, the paths a refresh needs, and the ports to probe.
 * @returns the status read and refresh trigger the local-bridge routes serve.
 */
export function createLocalBridgeControl(options: LocalBridgeControlOptions): LocalBridgeControl {
  const lockFile = join(options.harvestDir, '.auto-refresh.lock')
  /** Memoized runtime module; a failed load is retried by the next read. */
  let preflight: Promise<PreflightFacts> | undefined
  const facts = (): Promise<PreflightFacts> => (preflight ??= options.loadPreflight())

  /**
   * The epoch-millisecond stamp of a *held* refresh lock, or null. A stamp
   * older than the concurrency window is a dead attempt's residue, which the
   * next refresh reclaims, so reporting it as running would be wrong.
   */
  const heldRefreshStamp = async (windowMs: number): Promise<number | null> => {
    let text: string
    try {
      text = await readFile(lockFile, 'utf8')
    } catch {
      // Absent, or unreadable: either way no attempt is holding the lock.
      return null
    }
    const stamp = Number(text.trim())
    if (!Number.isFinite(stamp) || stamp <= 0) return null
    return Date.now() - stamp < windowMs ? stamp : null
  }

  return {
    async status(): Promise<LocalBridgeStatusPayload> {
      const module = await facts()
      const [harvest, apps, ca] = await Promise.all([
        module.detectHarvest(options.harvestDir),
        module.detectAllApps(),
        module.detectCa(),
      ])
      const [workbuddyRelay, copilotRelay, xiaoyiRelay, refreshStartedAt] = await Promise.all([
        relayStatus(options.workbuddyPort),
        relayStatus(options.copilotPort),
        relayStatus(options.xiaoyiPort),
        heldRefreshStamp(module.refreshLockMs),
      ])
      const xiaoyiCookie = xiaoyiRelay.listening
        ? await readXiaoyiCookie(options.xiaoyiPort)
        : ABSENT_COOKIE
      const copilot: LocalBridgeCopilotStatus = {
        relay: copilotRelay,
        app: appStatus(apps['copilot']),
        token: tokenStatus(harvest),
        missing: missingPrerequisites(harvest, ca.installed),
        mitmdump: harvest.mitmdump,
      }
      return {
        platform: process.platform,
        workbuddy: { relay: workbuddyRelay, app: appStatus(apps['workbuddy']) },
        copilot,
        xiaoyi: { relay: xiaoyiRelay, cookie: xiaoyiCookie },
        checkedAt: Date.now(),
        refreshStartedAt,
      }
    },

    async refresh(): Promise<LocalBridgeRefreshPayload> {
      const refuse = (refusal: LocalBridgeRefreshRefusal): LocalBridgeRefreshPayload =>
        ({ started: false, refusal, logFile: null })
      if (process.platform !== 'win32') return refuse('unsupported-platform')
      const module = await facts()
      if (await heldRefreshStamp(module.refreshLockMs) !== null) return refuse('busy')
      if (!existsSync(options.refreshScript)) return refuse('script-missing')
      const [harvest, apps] = await Promise.all([
        module.detectHarvest(options.harvestDir),
        module.detectAllApps(),
      ])
      if (!appStatus(apps['copilot']).running) return refuse('copilot-not-running')
      const ca = await module.detectCa()
      if (missingPrerequisites(harvest, ca.installed).length > 0) return refuse('prerequisites-missing')
      const outcome = await module.refreshCopilotToken({
        scriptPath: options.refreshScript,
        harvestDir: options.harvestDir,
      })
      if (!outcome.started) {
        // Every precondition above was met, so a refusal here is the refresh
        // process itself failing to start; the operator prose names the cause.
        options.log(`local-bridge: token refresh did not start: ${outcome.reason ?? 'unknown'}`)
        return refuse('spawn-failed')
      }
      return { started: true, refusal: null, logFile: outcome.logFile ?? null }
    },

    async log(): Promise<LocalBridgeLogPayload> {
      const module = await facts()
      return readLogs(options.harvestDir, module.refreshLogFiles)
    },
  }
}
