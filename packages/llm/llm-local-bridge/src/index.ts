/**
 * Built-in local-bridge LLM providers for the DeepSeek Harness desktop app.
 *
 * Three routes are registered here exactly the way `llm-deepseek` registers
 * `deepseek-official`: as fixed, code-level routes on the LLM seam, NOT through
 * the user-editable `llm-pi-ai` settings section.
 *
 * Why this lives in its own plugin instead of the `llm-pi-ai` config:
 * the web Models page only writes the `llm-pi-ai:` settings namespace, and a
 * patch entry there *replaces the whole `config`* — so any user who configures
 * even one custom provider on that page wipes these out. Registering them as
 * fixed routes (via `ctx.llm.registerAdapter`) puts them outside that
 * namespace entirely: the routes are decided by this file, not by any
 * settings layer, so no settings document can shadow or drop them.
 *
 * They appear in the model picker (the adapter advertises its catalog through
 * `listModels`/`providerInfo`) and in the Models settings page. Being *visible*
 * on that page and being *removable* there are two separate questions, and
 * this module answers both:
 *
 * - `registerConfigurableProviders` is what places a route into the Models
 *   page directory, so it is called. Each entry carries an **empty**
 *   `settingsPath`: the page derives its `removable` flag from a non-empty
 *   path living in the *user* layer, so an empty path is precisely what denies
 *   the page a delete control — the same reason `deepseek-official` is
 *   undeletable.
 * - The exported `Config` exists only so the Host's settings service has a
 *   namespace for those rows to anchor to, and it declares no field the
 *   routes actually read. `configure({ auto: false })` keeps the Plugins
 *   settings section from generating a page for it.
 *
 * All relays authenticate with the hop-specific `authorization: Bearer
 * local-bridge` header (see the `dsh-host-local-bridge` host plugin), so no
 * credential reference is needed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  authContextFrom,
  credentialStoreFrom,
  PiAiAdapter,
  resolveProfiles,
  type PiAiModelProfile,
  type PiAiProviderProfile,
  type PiAiReasoningEfforts,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

export const name = 'llm-local-bridge'
export const inject = ['llm']

/**
 * The reasoning levels one WorkBuddy model offers, keyed by the level pi-ai
 * dispatches.
 *
 * The account's product config lists each model's `reasoning.supportedEfforts`;
 * the levels below are exactly those, with the same spelling on the wire — the
 * cloud reads OpenAI's `reasoning_effort` and accepts these names as they are.
 *
 * `off` is deliberately absent from every model: pi-ai's OpenAI-compatible
 * transport encodes "do not think" as the **absence** of `reasoning_effort`,
 * which the cloud reads as "use this model's own default effort", not as
 * "think less". Declaring it would offer a control that does not do what it
 * says, so the picker offers the levels the cloud actually honours.
 */
type WorkBuddyEfforts = Exclude<PiAiReasoningEfforts, false>

/** The five levels the account's models draw from. */
const EFFORTS_LOW_HIGH: WorkBuddyEfforts = { low: 'low', high: 'high' }
const EFFORTS_LOW_MAX: WorkBuddyEfforts = { low: 'low', high: 'high', max: 'max' }
const EFFORTS_LOW_MEDIUM_HIGH: WorkBuddyEfforts = { low: 'low', medium: 'medium', high: 'high' }
const EFFORTS_LOW_MEDIUM_HIGH_XHIGH: WorkBuddyEfforts = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
}
const EFFORTS_FULL: WorkBuddyEfforts = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
}

/**
 * The WorkBuddy account's text models, as its own product config declares them.
 *
 * The relay passes `model` straight through to `https://www.workbuddy.ai/v2/chat/completions`,
 * so every id below is a working model id, not a label. The list is the account's
 * catalogue as of 2026-11-03: the `Auto`/`Fast`/`Balanced`/`Primary` aliases the
 * client resolves for the user, then the concrete models — DeepSeek,
 * GLM, the GPT-6 and GPT-5.6 families, Grok, Gemini, Kimi, and the Hunyuan
 * preview. All of them take images and tool calls.
 *
 * The account also carries `minimax-m3.1-flash`, which is deliberately absent:
 * the deployment reaches MiniMax over its own `minimax-official` channel, so a
 * second route to the same model would only split history and let a routing
 * rule pick the more expensive path by accident.
 *
 * `reasoningEfforts` is the account's own list of levels per model. A model
 * whose config names one fixed `effort` (the `Auto`/`Fast`/`Balanced`/`Primary`
 * aliases, `kimi-k3`) takes no level from the caller, so it declares
 * `reasoningEfforts: false` and the picker offers no control for it.
 *
 * `contextWindow` is the account's own input budget per model. It decides when
 * the harness compacts a conversation, so it has to be the real number: the
 * aliases are far smaller than the concrete models (`Auto` takes 176k, the GPT
 * family 1M), and a route that claims 1M for all of them lets a conversation
 * grow past what the model accepts before anything compacts it.
 *
 * The catalogue moves with the account: a tier change or a new model appears in
 * the WorkBuddy client before it appears here. The relay's `/v1/models` reads
 * the same product config the client caches, so it always shows the live set —
 * and it reports each model's levels and output cap, so a level this list no
 * longer offers is visible there before the cloud rejects it.
 */
const WORKBUDDY_MODELS: PiAiModelProfile[] = [
  { id: 'default-model', name: 'Auto', input: ['text', 'image'], reasoningEfforts: false, contextWindow: 176_000 },
  { id: 'fast-model', name: 'Fast', input: ['text', 'image'], reasoningEfforts: false, contextWindow: 200_000 },
  { id: 'balanced-model', name: 'Balanced', input: ['text', 'image'], reasoningEfforts: false, contextWindow: 256_000 },
  { id: 'primary-model', name: 'Primary', input: ['text', 'image'], reasoningEfforts: false, contextWindow: 272_000 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash (SG)', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', input: ['text', 'image'], reasoningEfforts: EFFORTS_FULL, contextWindow: 1_000_000 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MEDIUM_HIGH_XHIGH, contextWindow: 1_000_000 },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MEDIUM_HIGH_XHIGH, contextWindow: 1_000_000 },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MEDIUM_HIGH_XHIGH, contextWindow: 1_000_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', input: ['text', 'image'], reasoningEfforts: EFFORTS_FULL, contextWindow: 1_000_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', input: ['text', 'image'], reasoningEfforts: EFFORTS_FULL, contextWindow: 1_000_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', input: ['text', 'image'], reasoningEfforts: EFFORTS_FULL, contextWindow: 1_000_000 },
  { id: 'grok-4.7', name: 'Grok-4.7', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MEDIUM_HIGH_XHIGH, contextWindow: 500_000 },
  { id: 'gemini-3.8-flash', name: 'Gemini-3.8-Flash', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MEDIUM_HIGH, contextWindow: 1_000_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'kimi-k3.1-pro-highspeed', name: 'Kimi-K3.1-Pro-Highspeed', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_MAX, contextWindow: 1_000_000 },
  { id: 'kimi-k3', name: 'Kimi-K3', input: ['text', 'image'], reasoningEfforts: false, contextWindow: 1_000_000 },
  { id: 'hy4-preview', name: 'Hy4 Preview', input: ['text', 'image'], reasoningEfforts: { high: 'high' }, contextWindow: 1_000_000 },
  { id: 'hy3', name: 'Hy3', input: ['text', 'image'], reasoningEfforts: EFFORTS_LOW_HIGH, contextWindow: 192_000 },
]

/** Fixed provider routes this plugin owns, keyed by provider route. */
const BRIDGE_PROVIDERS: Record<string, PiAiProviderProfile> = {
  // WorkBuddy model relay (dsh-host-local-bridge, default 127.0.0.1:8787).
  dpv41f: {
    displayName: 'WorkBuddy Local Bridge',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8787/v1',
    headers: { authorization: 'Bearer local-bridge' },
    models: WORKBUDDY_MODELS,
  },
  // Microsoft Copilot relay (dsh-host-local-bridge, default 127.0.0.1:8899).
  //
  // 只声明 `text`：Copilot 的 SignalR chatHub 帧只有一个纯文本提示字段，没有附件
  // 字段。声明 image 会让 DSH 把附图送进请求，然后被反代以 `400 images_unsupported`
  // 拒掉 —— 那时消息已经落盘，会话只能反复重试一个注定失败的请求。少声明，DSH 才
  // 会在发送前就用 MODEL_DOES_NOT_SUPPORT_IMAGES 拦住，并给出可读的提示。
  slefgpt56: {
    displayName: 'Copilot Local Bridge',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8899/v1',
    headers: { authorization: 'Bearer local-bridge' },
    models: [
      { id: 'copilot', name: 'copilot', input: ['text'] },
      { id: 'm365-copilot', name: 'm365-copilot', input: ['text'] },
    ],
  },
  // Huawei Celia relay (dsh-host-local-bridge, default 127.0.0.1:8123).
  //
  // 只声明 `text`：小艺的通道是 `textRecognize`（文本进、文本出），没有附件字段，
  // 声明 image 会让 DSH 把附图直接送过去然后失败。少声明，DSH 才会在发送前就用
  // MODEL_DOES_NOT_SUPPORT_IMAGES 拦住，并给出可读的提示。
  hwcelia: {
    displayName: 'Huawei Celia Local Bridge',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8123/v1',
    headers: { authorization: 'Bearer local-bridge' },
    models: [
      { id: 'xiaoyi-chat', name: 'xiaoyi-chat', input: ['text'] },
      { id: 'xiaoyi', name: 'xiaoyi', input: ['text'] },
    ],
  },
}

/**
 * Anchor schema for the Models settings page.
 *
 * A plugin with no `Config` has no settings namespace at all, and `describe`
 * drops an entry whose schema projects no volatile field — so a directory
 * entry pointing at this plugin's namespace would vanish from the Models page
 * before it rendered. `routes` exists purely to materialize that namespace.
 *
 * It is not a configuration surface, and nothing here reads it:
 *
 * - The routes come from `BRIDGE_PROVIDERS` above, never from this value.
 * - The Models page cannot write it. Its curated provider editor covers only
 *   the `llm-deepseek` and `llm-pi-ai` namespaces; this one is unknown to it,
 *   so its editor renders the generic hint with Apply disabled.
 * - `configure({ auto: false })` keeps the Plugins settings section from
 *   generating a page for the namespace.
 */
export const Config = z.object({
  /** Route ids this plugin registers. Informational; editing it changes nothing. */
  routes: z.array(z.string().required()).default(Object.keys(BRIDGE_PROVIDERS)).volatile(),
})

export function apply(ctx: Context): void {
  // Mirror llm-pi-ai: keep the settings service alive for this fiber without
  // auto-generating a Plugins settings page for it. The bridge routes are not
  // settings-driven; this namespace exists only so the Models page can anchor
  // their read-only rows (see the Config docblock).
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // Resolve the fixed bridge profiles once at mount; they never change at
  // runtime, so the adapter's `profiles` hook simply returns the constant map.
  const profiles = resolveProfiles(structuredClone(BRIDGE_PROVIDERS), 'deferred')

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    // No credential reference: the `authorization: Bearer local-bridge` header
    // in each profile authenticates the request directly against the relay.
    resolveApiKey: () => Promise.resolve(undefined),
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        'llm-local-bridge: unusable replay state on assistant history for route'
        + ` "${provider}/${model}"; sending that message as provider-neutral content (${reason})`,
      )
    },
  })

  // Register every route as a fixed, built-in route.
  ctx.llm.registerAdapter([...profiles.keys()], adapter)

  // Place the same routes into the Models settings page directory so the
  // page shows them by name. `settingsNs` is this plugin's own namespace and
  // `settingsPath` is empty on purpose: the page marks a row removable only
  // when a non-empty path exists in the *user* settings layer, so an empty
  // path means these rows are listed but carry no delete control — exactly how
  // the built-in `deepseek-official` route behaves. Nothing here re-opens the
  // routes to user configuration; they are already registered above, from
  // code, and `declared` stays off so the page does not tag them as custom.
  ctx.llm.registerConfigurableProviders([...profiles].map(([provider, profile]) => ({
    provider,
    displayName: profile.displayName,
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  })))
}
