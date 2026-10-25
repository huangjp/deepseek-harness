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
  type PiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

export const name = 'llm-local-bridge'
export const inject = ['llm']

/** Fixed provider routes this plugin owns, keyed by provider route. */
const BRIDGE_PROVIDERS: Record<string, PiAiProviderProfile> = {
  // WorkBuddy model relay (dsh-host-local-bridge, default 127.0.0.1:8787).
  dpv41f: {
    displayName: 'WorkBuddy Local Bridge',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8787/v1',
    headers: { authorization: 'Bearer local-bridge' },
    models: [
      { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', input: ['text', 'image'] },
      { id: 'gpt-4o', name: 'gpt-4o', input: ['text', 'image'] },
      { id: 'gpt-3.5-turbo', name: 'gpt-3.5-turbo', input: ['text', 'image'] },
      { id: 'default', name: 'default', input: ['text', 'image'] },
    ],
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
