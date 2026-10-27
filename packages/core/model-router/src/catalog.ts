/**
 * A cached view of the registered provider routes, used to validate a routing
 * decision before the harness acts on it.
 *
 * @module @deepseek-ai/dsh-model-router/catalog
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RouteRule } from './rules.ts'

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
 * The registered routes and their models, cached for synchronous lookup.
 *
 * A routing decision happens between a message being claimed and the step
 * capturing its model selection, so the decision cannot await a catalog
 * lookup. The cache is refreshed when the registry changes, and a decision
 * whose target is not cached is declined rather than guessed: routing to an
 * unregistered route would fail the request instead of falling back.
 */
export class ModelCatalog {
  /** Provider route to model id to that model's capabilities. */
  private routes = new Map<string, Map<string, CatalogEntry>>()

  /**
   * @param ctx - the plugin context carrying the live LLM registry.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Re-read every registered route and its models.
   *
   * A route whose catalog cannot be read is skipped: the registry keeps the
   * route registered, and a later refresh may find it serviceable.
   * @returns a promise that settles once the cache is replaced.
   */
  async refresh(): Promise<void> {
    const next = new Map<string, Map<string, CatalogEntry>>()
    for (const provider of this.ctx.llm.listProviders()) {
      const entries = new Map<string, CatalogEntry>()
      try {
        for (const model of await this.ctx.llm.listModels(provider.id)) {
          const resolved = await this.ctx.llm.resolveModelInfo(provider.id, model.id).catch(() => undefined)
          entries.set(model.id, {
            modalities: model.inputModalities,
            efforts: resolved?.reasoning?.efforts.map(effort => effort.id) ?? [],
          })
        }
      } catch {
        continue
      }
      next.set(provider.id, entries)
    }
    this.routes = next
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
    const entry = this.routes.get(rule.provider)?.get(rule.model)
    if (entry === undefined) return undefined
    if (needsImage && entry.modalities !== undefined && !entry.modalities.includes('image')) return undefined
    const effort = rule.reasoningEffort === undefined ? undefined : ReasoningEffortId(rule.reasoningEffort)
    if (effort !== undefined && !entry.efforts.includes(effort)) {
      return { provider: rule.provider, model: rule.model }
    }
    return {
      provider: rule.provider,
      model: rule.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }
}
