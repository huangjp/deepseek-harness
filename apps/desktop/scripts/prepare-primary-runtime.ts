/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { cp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/**
 * Bundled skills the Desktop application ships.
 *
 * They leave the installer as ordinary files under `runtime/skills/`, outside the
 * ASAR, and the Host points `DSH_BUNDLED_SKILL_DIR` at that directory so the
 * skill provider discovers them on every install. A workspace copy outranks
 * them, because the bundled root ranks below the project and user roots.
 */
const BUNDLED_SKILL_DIRECTORIES = ['fiction-crafter']

/**
 * Copy the bundled skill directories into the runtime payload.
 * @param runtime - The runtime directory the installer carries.
 */
export async function prepareBundledSkills(runtime: string): Promise<void> {
  const source = new URL('../resources/skills/', import.meta.url)
  const destination = join(runtime, 'skills')
  await rm(destination, { recursive: true, force: true })
  for (const name of BUNDLED_SKILL_DIRECTORIES) {
    await cp(new URL(name, source), join(destination, name), { recursive: true, dereference: true })
  }
}

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: { deferSmoke?: boolean } = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await preparePayload({ target: resolveDesktopBuildTarget(), output: paths.runtime, cache: paths.downloads, version })
  await prepareBundledSkills(paths.runtime)
  if (!options.deferSmoke) smokePrimaryRuntime(join(paths.runtime, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
