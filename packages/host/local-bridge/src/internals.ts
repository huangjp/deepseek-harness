/**
 * Test seam for the relay runtime module; production keeps the empty default.
 *
 * `bridge/preflight.mjs` owns every fact about the machine the refresh chain
 * needs, and its real functions probe the machine, spawn PowerShell, and — on a
 * refresh — change the system proxy. A source-level test has to drive the
 * routes and the boot sequence without any of that, so it replaces the whole
 * module namespace here; production passes no value and the plugin imports the
 * module through its computed URL.
 */

/** Injectable relay-runtime module namespace used by source-level tests. */
export const internals: {
  /** Module namespace to serve instead of the shipped `bridge/preflight.mjs`. */
  preflight?: (() => Promise<Record<string, unknown>>) | undefined
} = {}
