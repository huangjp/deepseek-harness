/**
 * The file operations the Electron distribution step needs, kept apart from the
 * step itself.
 *
 * `prepare-runtime.ts` runs `main()` at module scope, so importing it starts a
 * real packaging run — including a real Electron download. These two functions
 * are pure file operations with no reason to drag that along, and the tests
 * that cover them need to import them without starting a download.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'

/**
 * Clear a directory, keeping any entry a running process still holds.
 *
 * `ELECTRON_RUN_AS_NODE` makes Electron open `resources/default_app.asar` when
 * it starts, so a second packaging run inside the same process tree finds that
 * file locked for as long as the earlier tree lives. The file holds Electron's
 * empty default app: the packaged application prefers `app.asar`, and
 * electron-builder leaves `default_app.asar` in the artifact too, so keeping
 * the old copy costs nothing while a delete that cannot complete would fail
 * the whole packaging step.
 *
 * @param dir - the directory to clear.
 * @returns the number of entries that could not be removed.
 */
export function clearTreeBestEffort(dir: string): number {
  try {
    rmSync(dir, { recursive: true, force: true })
    return 0
  } catch {
    // One held entry fails the whole recursive delete; clear the rest one by one.
  }
  let held = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true })
    } catch {
      held++
    }
  }
  return held
}

/**
 * Extract an Electron archive over a previous distribution.
 *
 * The archive is unpacked into a staging directory first, so a single held
 * file cannot fail the step: the held `resources/default_app.asar` keeps the
 * copy already in place, and everything else is replaced.
 *
 * @param archive - the downloaded Electron archive.
 * @param destination - the distribution directory to fill.
 */
export async function extractElectron(archive: string, destination: string): Promise<void> {
  const staging = `${destination}-staging`
  rmSync(staging, { recursive: true, force: true })
  try {
    await extractZip(archive, { dir: staging })
    const stagedDefaultApp = join(staging, 'resources', 'default_app.asar')
    if (existsSync(stagedDefaultApp) && existsSync(join(destination, 'resources', 'default_app.asar'))) {
      // The target copy is already in place and may be held open; the staged one
      // would only repeat it.
      rmSync(stagedDefaultApp, { force: true })
    }
    mkdirSync(destination, { recursive: true })
    cpSync(staging, destination, { recursive: true, force: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
