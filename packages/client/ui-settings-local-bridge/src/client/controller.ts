/**
 * The local-model-relay page's status store.
 *
 * The page reads two host routes — one status snapshot and one refresh
 * trigger — over the same document-relative carrier the Open-In controls use.
 * A refresh is a detached one-to-two-minute process on the host, so the page
 * observes it instead of awaiting it: while the held lock and the token's age
 * say an attempt is still running, this controller keeps re-reading.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  LOCAL_BRIDGE_REFRESH_ROUTE, LOCAL_BRIDGE_STATUS_ROUTE,
  type LocalBridgeAppStatus, type LocalBridgeCopilotStatus, type LocalBridgePrerequisite,
  type LocalBridgeRefreshPayload, type LocalBridgeRefreshRefusal, type LocalBridgeRelayStatus,
  type LocalBridgeStatusPayload, type LocalBridgeTokenStatus, type LocalBridgeWorkBuddyStatus,
} from '@deepseek-ai/dsh-host-local-bridge/shared'

/** HTTP carrier for the two control-plane routes. */
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Re-read cadence while a refresh attempt is running. A presentation cadence
 * rather than a deployment choice: the attempt lasts one to two minutes, so
 * this only decides how promptly the page notices it landed.
 */
const REFRESH_POLL_MS = 5_000

/** The prerequisite codes this build understands. */
const PREREQUISITES: readonly LocalBridgePrerequisite[] = ['mitmdump', 'harvester', 'upstream-proxy', 'ca']

/** The refresh refusal codes this build understands. */
const REFUSALS: readonly LocalBridgeRefreshRefusal[] = [
  'unsupported-platform', 'copilot-not-running', 'prerequisites-missing', 'busy', 'script-missing', 'spawn-failed',
]

/** What the page renders. */
export type LocalBridgePageState =
  /** No snapshot read has settled yet. */
  | { readonly phase: 'loading' }
  /** The host route did not answer, or answered with an unusable payload. */
  | { readonly phase: 'failed' }
  /** One status snapshot. */
  | { readonly phase: 'ready'; readonly status: LocalBridgeStatusPayload }

/**
 * Whether the host is running a refresh attempt right now.
 *
 * Two facts decide it, because the lock alone does not: the host holds the lock
 * for a fixed window even after the attempt ends, so a token harvested after
 * the lock was claimed is what marks completion.
 * @param status - the snapshot to read.
 * @returns whether new-token harvesting is still outstanding.
 */
export function refreshInFlight(status: LocalBridgeStatusPayload): boolean {
  if (status.refreshStartedAt === null) return false
  const harvestedAt = status.copilot.token.harvestedAt
  return harvestedAt === null || harvestedAt <= status.refreshStartedAt
}

/** Whether a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A required boolean field, or null when the value is not one. */
function booleanOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** A required finite number, or null when the value is not one. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A nullable numeric fact: null when the payload says null, undefined when the
 * payload is not a number at all, so the caller can tell absence from garbage.
 */
function nullableNumberOf(value: unknown): number | null | undefined {
  return value === null ? null : numberOf(value) ?? undefined
}

/** One relay listener, or null when the payload does not describe one. */
function parseRelay(value: unknown): LocalBridgeRelayStatus | null {
  if (!isRecord(value)) return null
  const port = numberOf(value['port'])
  const listening = booleanOf(value['listening'])
  return port === null || listening === null ? null : { port, listening }
}

/** One companion application's state, or null when the payload does not describe one. */
function parseApp(value: unknown): LocalBridgeAppStatus | null {
  if (!isRecord(value)) return null
  const installed = booleanOf(value['installed'])
  const running = booleanOf(value['running'])
  return installed === null || running === null ? null : { installed, running }
}

/** The token's age facts, or null when the payload does not describe them. */
function parseToken(value: unknown): LocalBridgeTokenStatus | null {
  if (!isRecord(value)) return null
  const present = booleanOf(value['present'])
  const stale = booleanOf(value['stale'])
  const harvestedAt = nullableNumberOf(value['harvestedAt'])
  const ageSec = nullableNumberOf(value['ageSec'])
  if (present === null || stale === null || harvestedAt === undefined || ageSec === undefined) return null
  return { present, harvestedAt, ageSec, stale }
}

/**
 * The unmet prerequisites, or null when the payload does not carry a list. A
 * code this build does not know is dropped rather than failing the whole read:
 * a version skew must not blank the rest of the page.
 */
function parseMissing(value: unknown): LocalBridgePrerequisite[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is LocalBridgePrerequisite =>
    PREREQUISITES.some(code => code === entry))
}

/** One Copilot status, or null when the payload does not describe one. */
function parseCopilot(value: unknown): LocalBridgeCopilotStatus | null {
  if (!isRecord(value)) return null
  const relay = parseRelay(value['relay'])
  const app = parseApp(value['app'])
  const token = parseToken(value['token'])
  const missing = parseMissing(value['missing'])
  const mitmdump = value['mitmdump']
  if (relay === null || app === null || token === null || missing === null) return null
  if (mitmdump !== null && typeof mitmdump !== 'string') return null
  return { relay, app, token, missing, mitmdump }
}

/** One WorkBuddy status, or null when the payload does not describe one. */
function parseWorkBuddy(value: unknown): LocalBridgeWorkBuddyStatus | null {
  if (!isRecord(value)) return null
  const relay = parseRelay(value['relay'])
  const app = parseApp(value['app'])
  return relay === null || app === null ? null : { relay, app }
}

/**
 * Validate one status response at the wire.
 * @param value - the decoded response body.
 * @returns the snapshot, or null when any field the page renders is unusable.
 */
export function parseStatusPayload(value: unknown): LocalBridgeStatusPayload | null {
  if (!isRecord(value)) return null
  const platform = value['platform']
  const checkedAt = numberOf(value['checkedAt'])
  const refreshStartedAt = nullableNumberOf(value['refreshStartedAt'])
  const workbuddy = parseWorkBuddy(value['workbuddy'])
  const copilot = parseCopilot(value['copilot'])
  if (typeof platform !== 'string' || checkedAt === null || refreshStartedAt === undefined
    || workbuddy === null || copilot === null) return null
  return { platform, workbuddy, copilot, checkedAt, refreshStartedAt }
}

/**
 * Validate one refresh response at the wire.
 * @param value - the decoded response body.
 * @returns the outcome, or null when the payload is unusable.
 */
export function parseRefreshPayload(value: unknown): LocalBridgeRefreshPayload | null {
  if (!isRecord(value)) return null
  const started = booleanOf(value['started'])
  if (started === null) return null
  const raw = value['refusal']
  const refusal = REFUSALS.find(code => code === raw) ?? null
  if (raw !== null && refusal === null) return null
  const logFile = value['logFile']
  if (logFile !== null && typeof logFile !== 'string') return null
  return { started, refusal, logFile }
}

/**
 * Owns the page's status snapshot and the refresh request.
 *
 * One read is published at a time: a later read supersedes an earlier one still
 * in flight, so a slow answer cannot overwrite a fresher snapshot.
 */
export class LocalBridgeController {
  /** The page snapshot. */
  readonly page: SnapshotStore<LocalBridgePageState> = createSnapshotStore<LocalBridgePageState>({ phase: 'loading' })
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private disposed = false

  /**
   * @param fetcher - HTTP carrier for the two routes.
   */
  constructor(private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}

  /**
   * Read one status snapshot, and keep reading while a refresh attempt runs.
   * @returns after the snapshot is published.
   */
  async load(): Promise<void> {
    if (this.isDisposed()) return
    const generation = ++this.generation
    this.clearTimer()
    let next: LocalBridgePageState
    try {
      const response = await this.fetcher(LOCAL_BRIDGE_STATUS_ROUTE, { headers: { accept: 'application/json' } })
      const parsed = response.ok ? parseStatusPayload(await response.json()) : null
      next = parsed === null ? { phase: 'failed' } : { phase: 'ready', status: parsed }
    } catch {
      // Swallows transport failures: an unreachable host reads as failed, and
      // the page offers the recheck that recovers from it.
      next = { phase: 'failed' }
    }
    if (this.isDisposed() || generation !== this.generation) return
    this.page.set(next)
    if (next.phase === 'ready' && refreshInFlight(next.status)) this.schedule()
  }

  /**
   * Ask the host to start a refresh, then read the state it left behind.
   * @returns the host's outcome, or null when the request itself failed.
   */
  async refresh(): Promise<LocalBridgeRefreshPayload | null> {
    let outcome: LocalBridgeRefreshPayload | null = null
    try {
      const response = await this.fetcher(LOCAL_BRIDGE_REFRESH_ROUTE, { method: 'POST' })
      outcome = response.ok ? parseRefreshPayload(await response.json()) : null
    } catch {
      // Swallows transport failures: the page reports the attempt as failed.
      outcome = null
    }
    await this.load()
    return outcome
  }

  /** Stop polling; the page calls this when it unmounts. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  /**
   * Whether disposal has run. Read through a method rather than the field so a
   * check after an `await` is not narrowed away by the earlier one.
   * @returns whether this controller has been disposed.
   */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Queue the next read of a running refresh attempt. */
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.load()
    }, REFRESH_POLL_MS)
  }

  /** Cancel a queued read. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
