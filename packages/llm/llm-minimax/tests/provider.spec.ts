/**
 * The route has to advertise MiniMax's own thinking depths, not a generic set.
 *
 * MiniMax accepts exactly `low`, `medium`, `high`, `xhigh`, and `max` in
 * `output_config.effort`, defaults to `max`, and answers `400` to
 * `thinking: {"type":"disabled"}` on the model that always thinks. Those three
 * facts are what the selector and the request builder read, so they are pinned
 * here against the profile the plugin actually registers.
 */

import { describe, expect, it } from 'vitest'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { getSupportedThinkingLevels } from '@deepseek-ai/dsh-llm-pi-ai/src/models.ts'
import {
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_EFFORT,
  MINIMAX_EFFORTS,
  MINIMAX_PROVIDER,
  minimaxModels,
  minimaxProfile,
} from '../src/index.ts'

/** The route the plugin registers, resolved the way the adapter resolves it. */
function route(): ResolvedPiAiProviderProfile {
  const profiles = resolveProfiles({
    [MINIMAX_PROVIDER]: minimaxProfile({ baseURL: MINIMAX_DEFAULT_BASE_URL, apiKeyEnv: 'MINIMAX_API_KEY' }),
  }, 'deferred')
  const profile = profiles.get(MINIMAX_PROVIDER)
  if (profile === undefined) throw new Error('the MiniMax profile must resolve into a route')
  return profile
}

/** One model of the resolved route. */
function model(id: string) {
  const found = route().piProvider?.getModels().find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the route must serve ${id}`)
  return found
}

describe('MiniMax route', () => {
  it('speaks the Anthropic Messages wire against the configured endpoint', () => {
    const profile = route()
    expect(profile.api).toBe('anthropic-messages')
    expect(profile.baseURL).toBe(MINIMAX_DEFAULT_BASE_URL)
    expect(profile.displayName).toBe('MiniMax')
  })

  it('offers exactly the depths MiniMax documents, from low to max', () => {
    expect(MINIMAX_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(getSupportedThinkingLevels(model('MiniMax-M3.1-Flash'))).toEqual([...MINIMAX_EFFORTS])
  })

  it('publishes max as the default depth, which is what MiniMax uses when a request names none', () => {
    expect(MINIMAX_DEFAULT_EFFORT).toBe('max')
    expect(route().reasoning).toBe('max')
  })

  it('never offers off on the model that rejects disabled thinking', () => {
    const map = model('MiniMax-M3.1-Flash').thinkingLevelMap
    // `off` pinned to null is how the catalog refuses a level: sending
    // `thinking: {"type":"disabled"}` here answers 400.
    expect(map).toMatchObject({ off: null })
    expect(getSupportedThinkingLevels(model('MiniMax-M3.1-Flash'))).not.toContain('off')
  })

  it('keeps off on the model whose thinking starts disabled', () => {
    expect(getSupportedThinkingLevels(model('MiniMax-M3'))).toContain('off')
  })

  it('sends each level under its own spelling and forces adaptive thinking', () => {
    for (const model of minimaxModels()) {
      expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false })
      for (const effort of MINIMAX_EFFORTS) expect(model.reasoningEfforts).toMatchObject({ [effort]: effort })
    }
  })

  it('declares the full multimodal context MiniMax serves', () => {
    for (const model of route().piProvider?.getModels() ?? []) {
      expect(model.contextWindow).toBe(1_000_000)
      expect(model.input).toContain('text')
      expect(model.input).toContain('image')
    }
  })
})
