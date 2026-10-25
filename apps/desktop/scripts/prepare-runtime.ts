/** Prepare the target Electron distribution and pinned pnpm CLI. */

import { packagingStep } from './packaging-step.mjs'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'

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

function preparePnpm(runtimeRoot: string): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('pnpm')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('desktop runtime: pnpm manifest has no version')
  const packageDir = dirname(manifestPath)
  const destination = join(runtimeRoot, 'pnpm')
  rmSync(destination, { recursive: true, force: true })
  cpSync(packageDir, destination, { recursive: true })
  return manifest.version
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  const buildPaths = resolveDesktopTargetBuildPaths()
  const runtimeRoot = buildPaths.runtime
  const target = resolveDesktopBuildTarget()
  const platform = target.startsWith('mac-') ? 'darwin' : 'win32'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  const require = createRequire(import.meta.url)
  const { version } = require('electron/package.json') as { version: string }
  const archive = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'download:electron',
    () => downloadArtifact({ version, platform, arch, artifactName: 'electron', cacheRoot: buildPaths.downloads }))
  const held = clearTreeBestEffort(buildPaths.electron)
  if (held > 0) {
    console.warn(`desktop prepare: ${held} 个文件仍被占用,保留旧副本;随后的解压会覆盖其余部分。`)
  }
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:electron',
    () => extractElectron(archive, buildPaths.electron))
  const executable = join(buildPaths.electron, platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
  const nodeVersion = execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
  rmSync(runtimeRoot, { recursive: true, force: true })
  mkdirSync(runtimeRoot, { recursive: true })
  const pnpmVersion = preparePnpm(runtimeRoot)
  cpSync(join(import.meta.dirname, 'node-bin'), join(runtimeRoot, 'bin'), { recursive: true })
  chmodSync(join(runtimeRoot, 'bin', 'node'), 0o755)
  writeFileSync(join(runtimeRoot, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: nodeVersion,
    pnpm: pnpmVersion,
  }, undefined, 2)}\n`)
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:primary-runtime',
    () => preparePrimaryRuntime({ deferSmoke: values['defer-primary-runtime-smoke'] }))
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
