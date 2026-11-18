/**
 * A cached view of the routes the rule table names, used to validate a routing
 * decision before the harness acts on it.
 *
 * @module @deepseek-ai/dsh-model-router/catalog
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RouteEndpoint, RouteRule } from './rules.ts'
import { ruleEndpoints } from './rules.ts'

/** What one cached model route can accept and offer. */
interface CatalogEntry {
  /** Accepted input modalities; absent means unknown, which is not a refusal. */
  readonly modalities: readonly ModelModality[] | undefined
  /** Selectable reasoning efforts, from the adapter that owns the route. */
  readonly efforts: readonly ReasoningEffortId[]
}

/** The provider route and model one decision resolved to. */
export interface RouteTarget {
  /** Registered provider route. */
  readonly provider: string
  /** Model id on that provider. */
  readonly model: string
  /** Reasoning effort, present only when the target route offers it. */
  readonly reasoningEffort?: ReasoningEffortId
}

/**
 * The routes the rule table names, cached for synchronous lookup.
 *
 * A routing decision happens between a message being claimed and the step
 * capturing its model selection, so the decision cannot await a catalog
 * lookup. The cache is refreshed when the registry changes, and a decision
 * whose target is not cached is declined rather than guessed: routing to an
 * unregistered route would fail the request instead of falling back.
 *
 * The cached routes are the ones the rule table names, resolved one exact
 * model at a time. A route's own model listing is not the source: that listing
 * reports a route as empty while the route's credential does not resolve, and
 * a route that cannot answer yet is still the route a rule names. Resolving the
 * exact model reads the route's configuration instead, which no credential
 * gates.
 */
export class ModelCatalog {
  /** Provider route to model id to that model's capabilities. */
  private routes = new Map<string, Map<string, CatalogEntry>>()

  /**
   * @param ctx - the plugin context carrying the live LLM registry.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Re-read the capabilities of every route the rule table names.
   *
   * A rule whose provider is not registered yet is skipped: the route may
   * register later, and a later refresh reads it. A rule whose provider is
   * registered but whose model is unknown is skipped as well, because the
   * deployment named a model that route does not serve.
   * @param rules - the rule table the deployment declared.
   * @param extra - tier route lists, which are not rules but still need a cached model.
   * @returns a promise that settles once the cache is replaced.
   */
  async refresh(rules: readonly RouteRule[], extra: readonly RouteEndpoint[] = []): Promise<void> {
    const next = new Map<string, Map<string, CatalogEntry>>()
    const registered = new Set(this.ctx.llm.listProviders().map(provider => provider.id))
    const endpoints = [
      ...rules.flatMap(rule => ruleEndpoints(rule)),
      ...extra,
    ]
    for (const endpoint of endpoints) {
      if (!registered.has(endpoint.provider)) continue
      const entries = next.get(endpoint.provider) ?? new Map<string, CatalogEntry>()
      if (entries.has(endpoint.model)) continue
      const resolved = await this.ctx.llm.resolveModelInfo(endpoint.provider, endpoint.model).catch(() => undefined)
      if (resolved === undefined) continue
      entries.set(endpoint.model, {
        modalities: resolved.inputModalities,
        efforts: resolved.reasoning?.efforts.map(effort => effort.id) ?? [],
      })
      next.set(endpoint.provider, entries)
    }
    this.routes = next
  }

  /**
   * Whether the catalog holds the capabilities of one exact route.
   * @param provider - provider route to look up.
   * @param model - model id on that route.
   * @returns true when the route's capabilities are cached.
   */
  has(provider: string, model: string): boolean {
    return this.routes.get(provider)?.has(model) === true
  }

  /**
   * Whether every provider the rule table names is registered.
   * @param rules - the rule table the deployment declared.
   * @param extra - tier route lists that must be registered too.
   * @returns true when no rule names an unregistered route.
   */
  covers(rules: readonly RouteRule[], extra: readonly RouteEndpoint[] = []): boolean {
    let registered: Set<string>
    try {
      registered = new Set(this.ctx.llm.listProviders().map(provider => provider.id))
    } catch (error: unknown) {
      // A registry that is still starting throws; the startup wait treats that as uncovered.
      void error
      return false
    }
    const providers = [
      ...rules.flatMap(rule => ruleEndpoints(rule).map(endpoint => endpoint.provider)),
      ...extra.map(endpoint => endpoint.provider),
    ]
    return providers.every(provider => registered.has(provider))
  }

  /**
   * Whether one cached route accepts an image.
   *
   * Unknown modalities are not a refusal: the route did not say it cannot
   * take an image. A route missing from the cache does not accept one,
   * because the router has nothing to send the image to.
   * @param provider - provider route to look up.
   * @param model - model id on that route.
   * @returns true when the route accepts an image or has not declared a modality.
   */
  acceptsImage(provider: string, model: string): boolean {
    const entry = this.routes.get(provider)?.get(model)
    if (entry === undefined) return false
    if (entry.modalities === undefined) return true
    return entry.modalities.includes('image')
  }

  /**
   * Resolve one rule into a target route, or decline it.
   *
   * The target must be a registered model. A rule that asks for an image is
   * declined when the target does not accept images, because the harness
   * would otherwise admit the attachment and the route would reject the
   * request. A requested effort is applied only when the target route offers
   * it; otherwise the route keeps its own default.
   * @param rule - the matched rule.
   * @param needsImage - whether the task carries an image.
   * @returns the target route, or undefined when the rule cannot be honored.
   */
  resolve(rule: RouteRule, needsImage: boolean): RouteTarget | undefined {
    return this.resolveEndpoint(rule, needsImage)
  }

  /**
   * Resolve one endpoint into a target route, or decline it.
   * @param endpoint - provider, model, and optional effort.
   * @param needsImage - whether the task carries an image.
   * @returns the target route, or undefined when the endpoint cannot be honored.
   */
  resolveEndpoint(endpoint: RouteEndpoint, needsImage: boolean): RouteTarget | undefined {
    const entry = this.routes.get(endpoint.provider)?.get(endpoint.model)
    if (entry === undefined) return undefined
    if (needsImage && entry.modalities !== undefined && !entry.modalities.includes('image')) return undefined
    const effort = endpoint.reasoningEffort === undefined ? undefined : ReasoningEffortId(endpoint.reasoningEffort)
    if (effort !== undefined && !entry.efforts.includes(effort)) {
      return { provider: endpoint.provider, model: endpoint.model }
    }
    return {
      provider: endpoint.provider,
      model: endpoint.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }
}
