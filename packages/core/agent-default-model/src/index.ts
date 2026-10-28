/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection, RoutingMode } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /** Routing mode new Sessions follow while they record none of their own. */
  routingMode: Volatile<RoutingMode>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
    routingMode: z.union([z.const('auto'), z.const('fixed')]).default('auto').volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    // The write is deferred behind earlier saves, so the submitted values are
    // captured now: a caller may mutate the object it passed in meanwhile.
    const selection: ModelSelection = { ...next }
    const saved = this.saves.then(() => editor.edit(entry, (current) => {
      const config: Record<string, unknown> = { ...current, provider: selection.provider, model: selection.model }
      if (selection.reasoningEffort === undefined) Reflect.deleteProperty(config, 'reasoningEffort')
      else config.reasoningEffort = String(selection.reasoningEffort)
      return config
    }))
    this.saves = saved.catch(() => {})
    await saved
  }

  /**
   * Read the routing mode new Sessions follow while they record none of their own.
   * @returns the deployment's default routing mode.
   */
  currentRoutingMode(): RoutingMode {
    return this.config.routingMode.get()
  }

  /**
   * Save the default routing mode. The mode outlives the Session that chose it,
   * so a Session that pinned a model keeps that choice in the Sessions that follow.
   * @param mode - routing mode to store.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveRoutingMode(mode: RoutingMode): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const saved = this.saves.then(() => editor.edit(entry, current => ({ ...current, routingMode: mode })))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
