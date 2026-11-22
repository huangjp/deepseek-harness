/**
 * The shipped routing table has to survive the installer.
 *
 * A fresh machine starts from an empty profile patch, so the bundle layers are
 * the only place that can carry the table: with no `model-router` config the
 * plugin keeps its own default of `enabled: false`, the model catalog
 * advertises no automatic routing, and the model switcher never offers it.
 * This suite composes the two bundle layers the way the Loader does for an
 * untouched profile, then pins what the composition yields — that the
 * override finds its row instead of being dropped as an untargeted patch, the
 * rule order (the first match wins), the two catch-alls that leave no task
 * unrouted, and the route ids the rules name.
 */

import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

/** One routing rule as the bundle declares it. */
interface ShippedRule {
  name: string
  keywords: string[]
  hasImage?: boolean
  provider: string
  model: string
  reasoningEffort?: string
}

/** The `model-router` config the bundle ships. */
interface ShippedRouterConfig {
  enabled: boolean
  rules: ShippedRule[]
  failureThreshold: number
  cooldownMs: number
}

/** Compose the base and web-app layers exactly as an untouched profile boots them. */
function composeBundles(): { entries: EntryOptions[]; warnings: string[] } {
  const warnings: string[] = []
  const warn = (message: string, ...args: unknown[]): void => { warnings.push(`${message} ${args.join(' ')}`) }
  const base = loadOverlayPatches('routing-defaults', fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url)))
  const web = loadOverlayPatches('routing-defaults', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const baseEntries = applyEntryPatches([], base, warn).data
  return { entries: applyEntryPatches(baseEntries, web, warn).data, warnings }
}

/** Read the routing table the composed bundles mount. */
function shippedRouterConfig(): ShippedRouterConfig {
  const { entries, warnings } = composeBundles()
  // A patch that matches no row is skipped with a warning, so the table would
  // vanish on every install without any boot failure to notice it by.
  expect(warnings.filter(warning => warning.includes('model-router'))).toEqual([])
  const entry = entries.find(candidate => candidate.id === 'model-router')
  if (entry === undefined) throw new Error('the composed web-app layers must mount the model-router row')
  expect(entry.name).toBe('@deepseek-ai/dsh-model-router')
  return entry.config as ShippedRouterConfig
}

describe('shipped routing table', () => {
  it('turns automatic routing on, because the catalog advertises it only when the namespace says so', () => {
    expect(shippedRouterConfig().enabled).toBe(true)
  })

  it('evaluates the task rules before the catch-alls, in declaration order', () => {
    expect(shippedRouterConfig().rules.map(rule => rule.name)).toEqual([
      'deep-reasoning',
      'microsoft-office',
      'creative-writing',
      'quick-text',
      'fallback-image',
      'fallback-text',
    ])
  })

  it('routes the relay-served task kinds to the models those relays declare', () => {
    // The ids are fixed in `@deepseek-ai/dsh-llm-local-bridge`; a model this
    // table names but the relay does not serve declines the rule at decision
    // time, and the task would silently land on a catch-all instead.
    const routes = new Map(shippedRouterConfig().rules.map(rule => [rule.name, `${rule.provider}/${rule.model}`]))
    expect(routes.get('microsoft-office')).toBe('slefgpt56/copilot')
    expect(routes.get('creative-writing')).toBe('hwcelia/xiaoyi-chat')
  })

  it('leaves no task unrouted: one catch-all per image state, both on a route the bundle registers', () => {
    const catchAlls = shippedRouterConfig().rules.filter(rule => rule.keywords.length === 0 && rule.hasImage !== undefined)
    expect(catchAlls.map(rule => rule.hasImage)).toEqual([true, false])
    // The catch-alls must name a route the bundle itself registers, or a task
    // would run unrouted.
    for (const rule of catchAlls) expect(`${rule.provider}/${rule.model}`).toBe('dpv41f/deepseek-v4.1-flash')
  })

  it('sends the MiniMax rules to the first-party MiniMax route, not a user-declared one', () => {
    // `minimax` is the route `@deepseek-ai/dsh-llm-minimax` registers. A rule
    // naming a provider id that only a user profile declares is skipped on a
    // fresh install, so the reasoning and quick-text rules would silently fall
    // through to the catch-all.
    const routes = new Map(shippedRouterConfig().rules.map(rule => [rule.name, `${rule.provider}/${rule.model}`]))
    expect(routes.get('deep-reasoning')).toBe('minimax-official/MiniMax-M3.1-Flash')
    expect(routes.get('quick-text')).toBe('minimax-official/MiniMax-M3.1-Flash')
  })

  it('asks MiniMax for the thinking depths its own endpoint accepts', () => {
    const efforts = shippedRouterConfig().rules
      .filter(rule => rule.provider === 'minimax-official')
      .map(rule => rule.reasoningEffort)
    expect(efforts).toEqual(['high', 'low'])
  })

  it('carries the breaker knobs the rule table relies on', () => {
    const config = shippedRouterConfig()
    expect(config.failureThreshold).toBe(2)
    expect(config.cooldownMs).toBe(300_000)
  })
})
