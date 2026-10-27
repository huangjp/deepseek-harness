/**
 * The model router's settings page, browser half: the task-to-route rule table
 * over the `model-router` namespace the router plugin owns. The page registers
 * into the Plugins page's `plugins.item` slot while the Host serves that
 * namespace, so a deployment that exposes no model router shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ModelRouterCard } from './ModelRouterCard.tsx'
import { MODEL_ROUTER_NS, ModelRouterCardController } from './model-router-card-controller.ts'
import { en, ja, es, fr, de, ru, pt, zh, type ModelRouterSettingsLocaleKey } from './locales.ts'

export type { ModelRouterCardProps } from './ModelRouterCard.tsx'
export type {
  ModelRouterCardFace, ModelRouterCardState, ModelRouterSettings, RouteRule, RouteRulePatch,
} from './model-router-card-controller.ts'
export type { ModelRouterSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model router settings page copy. */
    'settings.modelRouter': ModelRouterSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.modelRouter'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Mount the model router's settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-model-router: dictionaries')
  const t = ctx.locale.bind(NS)
  const card = new ModelRouterCardController(ctx.configForms.get(MODEL_ROUTER_NS), ctx)
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-model-router: form subscription')
  // The model directory is not part of the settings section: adapters come and
  // go, so a rule may name a route the last read did not know yet.
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { card.refreshCatalog() }),
    'ui-settings-model-router: adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { card.refreshCatalog() }),
    'ui-settings-model-router: settings invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([MODEL_ROUTER_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'model-router', order: 40, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, ModelRouterCard))), 'ui-settings-model-router: page')
}
