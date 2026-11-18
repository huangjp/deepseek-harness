/**
 * The provider inside a real booted composition.
 *
 * The Models page lists a provider only when the settings service serves the
 * namespace its directory entry names, so a plugin that registers a route
 * without publishing that namespace is invisible on the page even though the
 * route exists. This boots the real application tree — the way the desktop app
 * does — and asserts both halves.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Hmr from '@deepseek-ai/dsh-hmr'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Settings from '@deepseek-ai/dsh-settings'
import { expect, it, onTestFinished } from 'vitest'
import * as MiniMax from '../src/index.ts'

/** Boot one profile whose bundle mounts the MiniMax provider. */
async function composed(): Promise<Context> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'minimax-composition-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{
    insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'llm', name: 'cordis:llm' },
      // Mounted before the fixed route on purpose: pi-ai declares every
      // provider of its installed catalog in the Models-page directory from
      // the moment it mounts, and that catalog ships a `minimax` entry. A
      // fixed route that reused that id loses the declaration with
      // `DUPLICATE_DIRECTORY` and never activates.
      { id: 'llm-pi-ai', name: 'cordis:pi-ai' },
      { id: 'llm-minimax', name: 'cordis:minimax' },
    ],
  }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (context) => {
    context.provide('profileContext', profile)
    context.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(context.loader.builtins, {
      editor: ConfigEditor, settings: Settings, llm: LlmRuntime, minimax: MiniMax, 'pi-ai': LlmPiAi,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})
  return ctx
}

it('registers the route and the namespace the Models page lists it under', async () => {
  const ctx = await composed()
  expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('minimax-official')
  expect(ctx.settings.describe({ redactSecrets: true }).map(view => view.ns)).toContain('llm-minimax')
})

it('pairs the directory entry with that namespace, so the row is listable', async () => {
  const ctx = await composed()
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'minimax-official')
  expect(entry).toBeDefined()
  expect(ctx.settings.describe().map(view => view.ns)).toContain(entry?.settingsNs)
})

it('carries the key reference the page writes and reads', async () => {
  const ctx = await composed()
  const namespace = ctx.settings.describe({ redactSecrets: true }).find(view => view.ns === 'llm-minimax')
  expect((namespace?.value as { apiKeyEnv?: string } | undefined)?.apiKeyEnv).toBe('MINIMAX_API_KEY')
})
