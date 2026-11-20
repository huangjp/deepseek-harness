/**
 * The desktop Models page lists a provider only when two facts agree: the
 * configurable-provider directory names it, and settings serves the namespace
 * that entry addresses. The desktop profile composes `@deepseek-ai/dsh-base`
 * and `@deepseek-ai/dsh-web-app` — the same pair the web template uses — and
 * does not repeat the MiniMax, xAI, or 4SAPI rows. Those rows have to survive
 * that composition and register when they are mounted beside `llm-pi-ai`,
 * whose catalog already occupies the vendor ids `minimax` and `xai`.
 *
 * The packaged host loads each plugin's `lib/*.js` under plain Node. Node
 * refuses to strip TypeScript inside `node_modules`, so a runtime import of
 * `@deepseek-ai/dsh-llm-pi-ai/src/*.ts` fails the plugin before it can
 * register a row. The import check below locks the compiled subpath.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, composeEntries, initProfile, loadOverlayPatches, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Hmr from '@deepseek-ai/dsh-hmr'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Foursapi from '@deepseek-ai/dsh-llm-4sapi'
import * as MiniMax from '@deepseek-ai/dsh-llm-minimax'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Xai from '@deepseek-ai/dsh-llm-xai'
import Settings from '@deepseek-ai/dsh-settings'
import { expect, it, onTestFinished } from 'vitest'

/** One Models-page row the desktop composition must keep. */
const ROUTES = [
  { id: 'llm-minimax', provider: 'minimax-official', displayName: 'MiniMax', apiKeyEnv: 'MINIMAX_API_KEY' },
  { id: 'llm-xai', provider: 'xai-official', displayName: 'xAI', apiKeyEnv: 'XAI_API_KEY' },
  { id: 'llm-4sapi', provider: '4sapi-relay', displayName: '4SAPI', apiKeyEnv: 'FOURSAPI_API_KEY' },
] as const

/** Production modules whose packaged bundle must not import TypeScript from another package. */
const PACKAGED_SOURCES = [
  '../../../llm/llm-minimax/src/provider.ts',
  '../../../llm/llm-xai/src/provider.ts',
  '../../../llm/llm-4sapi/src/provider.ts',
  '../../../llm/llm-local-bridge/src/index.ts',
]

/** Read one bundle's patch files in the order its manifest declares. */
function bundleLayer(packageJson: URL): PatchOptions[] {
  const manifestPath = fileURLToPath(packageJson)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh: { bundle: { patch: string | readonly string[] } }
  }
  const declared = manifest.dsh.bundle.patch
  const files = typeof declared === 'string' ? [declared] : declared
  return files.flatMap(file => loadOverlayPatches('desktop-provider-directory', join(dirname(manifestPath), file)))
}

/** Compose the desktop profile's two bundle layers, base then web-app. */
function desktopEntries() {
  const warnings: string[] = []
  const entries = composeEntries([
    bundleLayer(new URL('../package.json', import.meta.url)),
    bundleLayer(new URL('../../web-app/package.json', import.meta.url)),
  ], (message) => { warnings.push(message) })
  return { entries, warnings }
}

/** Boot the real provider modules under the entry ids the desktop bundles use. */
async function bootProviders(): Promise<Context> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-provider-directory-')))
  const dir = join(home, 'profiles', 'desktop')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{
    insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'llm', name: 'cordis:llm' },
      // pi-ai first, as the base bundle does: its catalog claims `minimax` and
      // `xai`, and a later route that reused either id would fail to register.
      { id: 'llm-pi-ai', name: 'cordis:pi-ai' },
      { id: 'llm-minimax', name: 'cordis:minimax' },
      { id: 'llm-xai', name: 'cordis:xai' },
      { id: 'llm-4sapi', name: 'cordis:foursapi' },
    ],
  }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'desktop', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlayPaths: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('desktop-provider-directory', join(dir, 'cordis.yml'), readProfilePatches('desktop-provider-directory', profile), (context) => {
    context.provide('profileContext', profile)
    context.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(context.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      llm: LlmRuntime,
      'pi-ai': PiAi,
      minimax: MiniMax,
      xai: Xai,
      foursapi: Foursapi,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})
  return ctx
}

it('keeps the three first-party routes in the desktop bundle composition', () => {
  const { entries, warnings } = desktopEntries()
  expect(warnings.filter(warning => ROUTES.some(route => warning.includes(route.id)))).toEqual([])
  for (const route of ROUTES) {
    const entry = entries.find(candidate => candidate.id === route.id)
    expect(entry?.name).toBe(`@deepseek-ai/dsh-${route.id}`)
    expect(entry?.disabled).not.toBe(true)
  }
})

it('registers those routes on the Models-page directory with the namespaces the page lists', async () => {
  const ctx = await bootProviders()
  const directory = ctx.llm.listConfigurableProviders()
  const described = ctx.settings.describe({ redactSecrets: true })
  const valueOf = (id: string): unknown => described.find(view => view.ns === id)?.value
  for (const route of ROUTES) {
    const entry = directory.find(candidate => candidate.provider === route.provider)
    expect(entry).toMatchObject({
      provider: route.provider,
      displayName: route.displayName,
      settingsNs: route.id,
      settingsPath: [],
    })
    expect(valueOf(route.id)).toMatchObject({ apiKeyEnv: route.apiKeyEnv })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain(route.provider)
  }
  expect(valueOf('llm-4sapi')).toMatchObject({ baseURL: 'https://4sapi.com/v1' })
})

it('imports pi-ai helpers from the compiled subpath, which plain Node can load inside node_modules', () => {
  for (const relative of PACKAGED_SOURCES) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    expect(source).toContain("from '@deepseek-ai/dsh-llm-pi-ai/route-support'")
    expect(source).not.toMatch(/@deepseek-ai\/dsh-llm-pi-ai\/src\//)
  }
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../llm/llm-pi-ai/package.json', import.meta.url)),
    'utf8',
  )) as { exports: Record<string, { types?: string; default?: string }>; files: string[] }
  expect(manifest.exports['./route-support']).toEqual({
    types: './lib/types/route-support.d.ts',
    default: './lib/route-support.js',
  })
  expect(manifest.files).toContain('lib/route-support.js')
})
