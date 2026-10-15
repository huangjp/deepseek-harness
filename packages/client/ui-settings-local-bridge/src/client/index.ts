/**
 * The local-model-relay settings page, browser half. It registers one
 * `settings.section` entry that reads the two control-plane routes
 * `@deepseek-ai/dsh-host-local-bridge` serves: one status snapshot of both
 * bundled relays, and the trigger for a Copilot token refresh.
 *
 * The host reports facts and fixed codes only — the diagnostics the refresh
 * chain writes are operator prose in another language — so every sentence the
 * user reads comes from this plugin's own dictionary.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocalBridgeController } from './controller.ts'
import { LocalBridgeSection, type LocalBridgeSectionInjected } from './LocalBridgeSection.tsx'
import { en, zh, type LocalBridgeLocaleKey } from './locales.ts'

export type { LocalBridgeLogState, LocalBridgePageState } from './controller.ts'
export type { LocalBridgeSectionInjected, LocalBridgeSectionProps } from './LocalBridgeSection.tsx'
export type { LocalBridgeLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local-model-relay settings page copy. */
    'settings.localBridge': LocalBridgeLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.localBridge'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the local-model-relay page and keep its status store wired.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-local-bridge: copy dictionaries')
  const controller = new LocalBridgeController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-local-bridge: status polling')
  // Registration-time text (the nav label thunk) and the inject face share one
  // bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS)
  const injected = (): LocalBridgeSectionInjected => ({
    hooks: { page: controller.page, log: controller.logs },
    load: () => controller.load(),
    refresh: () => controller.refresh(),
    t,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'local-bridge',
    // After the Models page (10): the routes this page reports on are the ones
    // that page lists.
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, LocalBridgeSection))
}
