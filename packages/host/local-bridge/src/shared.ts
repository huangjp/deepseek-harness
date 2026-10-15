/**
 * Route paths and wire payloads shared verbatim by the host routes and the
 * browser package (`@deepseek-ai/dsh-client-ui-settings-local-bridge`),
 * published as the `./shared` subpath. Browser-safe: constants and types only.
 *
 * Every payload carries facts and fixed codes, never prose. The operator
 * diagnostics `bridge/preflight.mjs` produces are Chinese-language text, and
 * the settings page renders its copy from its own locale dictionary, so a
 * refusal travels as a member of {@link LocalBridgeRefreshRefusal} and the
 * browser chooses the guidance.
 */

/** GET route path serving one local-bridge status snapshot. */
export const LOCAL_BRIDGE_STATUS_PATH = '/local-bridge/status'

/** Browser-relative form of {@link LOCAL_BRIDGE_STATUS_PATH}. */
export const LOCAL_BRIDGE_STATUS_ROUTE = LOCAL_BRIDGE_STATUS_PATH.slice(1)

/** POST route path starting one Copilot token refresh. */
export const LOCAL_BRIDGE_REFRESH_PATH = '/local-bridge/refresh'

/** Browser-relative form of {@link LOCAL_BRIDGE_REFRESH_PATH}. */
export const LOCAL_BRIDGE_REFRESH_ROUTE = LOCAL_BRIDGE_REFRESH_PATH.slice(1)

/** Whether one companion desktop application is installed and running. */
export interface LocalBridgeAppStatus {
  /** The application is present on this machine. */
  readonly installed: boolean
  /** The application's process is running now. */
  readonly running: boolean
}

/** One relay's listener. */
export interface LocalBridgeRelayStatus {
  /** Loopback port the relay is configured to listen on. */
  readonly port: number
  /** A TCP connect to that port succeeded at read time. */
  readonly listening: boolean
}

/** The harvested Copilot access token's age. */
export interface LocalBridgeTokenStatus {
  /** A harvested token file exists. */
  readonly present: boolean
  /** Harvest time in epoch milliseconds; null without a token. */
  readonly harvestedAt: number | null
  /** Age in seconds; null without a token. */
  readonly ageSec: number | null
  /** Older than the platform's access-token lifetime. */
  readonly stale: boolean
}

/**
 * What a Copilot token refresh needs and does not have. Each member names a
 * fact the settings page can act on, which is why the host reports the code
 * rather than the operator text `bridge/preflight.mjs` writes for its log.
 */
export type LocalBridgePrerequisite =
  /** The interception proxy executable is not resolvable on this machine. */
  | 'mitmdump'
  /** The interception script is absent from the harvest directory. */
  | 'harvester'
  /** The upstream proxy the harvester tunnels through is not listening. */
  | 'upstream-proxy'
  /** The interception certificate is not in the trusted root store. */
  | 'ca'

/** Why a refresh request did not start. */
export type LocalBridgeRefreshRefusal =
  /** The refresh chain is Windows-only. */
  | 'unsupported-platform'
  /** The Copilot desktop application is not running. */
  | 'copilot-not-running'
  /** At least one member of {@link LocalBridgeCopilotStatus.missing} is unmet. */
  | 'prerequisites-missing'
  /** An earlier attempt still holds the refresh lock. */
  | 'busy'
  /** The refresh script is not on disk. */
  | 'script-missing'
  /** The refresh process could not be started. */
  | 'spawn-failed'

/** Copilot relay facts: listener, token age, and what a refresh still needs. */
export interface LocalBridgeCopilotStatus {
  /** The Copilot relay's listener. */
  readonly relay: LocalBridgeRelayStatus
  /** The Copilot desktop application behind it. */
  readonly app: LocalBridgeAppStatus
  /** The harvested access token's age. */
  readonly token: LocalBridgeTokenStatus
  /** Unmet refresh prerequisites; empty when a refresh can start now. */
  readonly missing: readonly LocalBridgePrerequisite[]
  /** Resolved interception-proxy executable path, or null when none was found. */
  readonly mitmdump: string | null
}

/** WorkBuddy relay facts: listener and the application behind it. */
export interface LocalBridgeWorkBuddyStatus {
  /** The WorkBuddy relay's listener. */
  readonly relay: LocalBridgeRelayStatus
  /** The WorkBuddy desktop application behind it. */
  readonly app: LocalBridgeAppStatus
}

/** One status snapshot of both bundled relays. */
export interface LocalBridgeStatusPayload {
  /** `process.platform` of the host, so the page gates Windows-only actions. */
  readonly platform: string
  /** The WorkBuddy relay. */
  readonly workbuddy: LocalBridgeWorkBuddyStatus
  /** The Copilot relay. */
  readonly copilot: LocalBridgeCopilotStatus
  /** Epoch milliseconds this snapshot was read. */
  readonly checkedAt: number
  /**
   * Epoch milliseconds the current refresh attempt claimed its lock; null when
   * none is held. An attempt whose token is newer than this stamp has finished,
   * so the page reads two facts instead of trusting the lock's lifetime.
   */
  readonly refreshStartedAt: number | null
}

/** Refresh-route response, and the request body (which carries no fields). */
export interface LocalBridgeRefreshPayload {
  /** Whether a refresh process was started. */
  readonly started: boolean
  /** Why it did not start; null once started. */
  readonly refusal: LocalBridgeRefreshRefusal | null
  /** Host-side transcript path once started; null otherwise. */
  readonly logFile: string | null
}
