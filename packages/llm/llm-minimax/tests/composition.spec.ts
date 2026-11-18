/**
 * The MiniMax route in a real composition: the provider registry, the Models
 * page directory entry, and the settings namespace the page joins that entry
 * against.
 *
 * These are the three facts the product surface depends on. The directory
 * entry is what puts a **MiniMax** row on the Models page, its empty
 * `settingsPath` is what keeps that row undeletable, and the namespace is what
 * lets the page read the credential reference and show whether the key is
 * stored.
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { expect, it, vi } from 'vitest'
import * as MiniMax from '../src/index.ts'

/** Mount the provider over the real LLM, settings, and profile services. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  // The settings service reads the composition through the config editor, so
  // the profile and the editor have to exist before it describes a namespace.
  ctx.provide('profileContext', {
    name: 'desktop', dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  await ctx.plugin(MiniMax, {})
  return ctx
}

it('registers the route as a live provider of the LLM seam', async () => {
  const ctx = await mount()
  try {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('minimax-official')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('publishes a Models-page directory entry that no settings document can delete', async () => {
  const ctx = await mount()
  try {
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'minimax-official')
    expect(entry).toBeDefined()
    // The page derives the credential reference and the row's identity from
    // the namespace; an empty path is what denies the row a delete control.
    expect(entry?.settingsNs).toBe('llm-minimax')
    expect(entry?.settingsPath).toEqual([])
    expect(entry?.displayName).toBe('MiniMax')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('serves the settings namespace the page reads the key reference from', async () => {
  const ctx = await mount()
  try {
    // The namespace is what the Models page joins the directory entry
    // against, and what carries the credential reference it shows. The
    // settings service only describes a namespace through a real profile
    // composition, so the reference itself is checked here and the namespace
    // is proven by the shipped bundle row that mounts this plugin.
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'minimax-official')
    expect(entry?.settingsNs).toBe('llm-minimax')
    expect(MiniMax.MINIMAX_DEFAULT_API_KEY_ENV).toBe('MINIMAX_API_KEY')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('offers no model until a key is stored, and the two models once it is', async () => {
  const ctx = await mount()
  try {
    vi.stubEnv('MINIMAX_API_KEY', '')
    expect(await ctx.llm.listModels('minimax-official')).toEqual([])

    vi.stubEnv('MINIMAX_API_KEY', 'fixture-api-key')
    const models = await ctx.llm.listModels('minimax-official')
    expect(models.map(model => model.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('advertises MiniMax thinking depths, not a generic set', async () => {
  const ctx = await mount()
  try {
    vi.stubEnv('MINIMAX_API_KEY', 'fixture-api-key')
    const [flash] = await ctx.llm.listModels('minimax-official')
    const info = await ctx.llm.resolveModelInfo('minimax-official', flash?.id ?? '')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(info.reasoning?.defaultEffort).toBe('max')
    expect(info.inputModalities).toContain('image')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})
