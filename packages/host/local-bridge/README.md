---
description: "The host plugin that starts the three locally bundled model relays and serves the status and token-refresh routes the settings page reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-local-bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-local-bridge` starts the three model relays bundled with the desktop installer as independent loopback listeners: the WorkBuddy relay on `127.0.0.1:8787`, the Microsoft Copilot relay on `127.0.0.1:8899`, and the Huawei Celia relay on `127.0.0.1:8123`. Before any of them listens it runs a dependency preflight that starts the desktop applications behind them, deploys the harvest files, imports the interception certificate, and refreshes a stale Copilot access token. The same plugin serves the routes the “Local model services” settings page reads: one status snapshot of the relays, the trigger for a Copilot token refresh, and the tails of the transcripts that refresh writes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition that ships the bundled relays; the desktop app's `web-app` bundle is the one that does. The relays are served by the separate `@deepseek-ai/dsh-llm-local-bridge` plugin, which declares the routes `dpv41f` and `slefgpt56` on the LLM seam; this package only starts the processes those routes reach.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Start the relays at all; the settings routes exist either way |
| `host` | `127.0.0.1` | Bind address both relays share |
| `port` | `8787` | WorkBuddy relay port |
| `backend` | `wbcloud` | WorkBuddy model channel: `wbcloud` (talk to WorkBuddy's cloud directly, with the official-client channel headers), `serve` (the client gateway), `cli` (the CodeBuddy CLI), or `openai` (any OpenAI-compatible endpoint) |
| `cacheDir` | system temp | Gateway credential cache; the install directory is usually not writable |
| `wbcloud.python` | auto-detected | Interpreter used to run `bridge/workbuddy-token.py`; empty means look under `%LOCALAPPDATA%\Programs\Python` and on `PATH` |
| `wbcloud.harvestScript` | bundled | Script that harvests the WorkBuddy access token out of the client's process memory; empty means use `bridge/workbuddy-token.py`. The script caches the token under `%LOCALAPPDATA%\workbuddy-bridge\token.json` and relaunches itself elevated when the client runs elevated and the scan is refused |
| `wbcloud.catalogDir` | `%USERPROFILE%\.workbuddy-ai\cache` | Directory holding the product config the WorkBuddy client caches; the relay reads the account's model catalogue from it |
| `copilot.enabled` | `true` | Start the Copilot relay |
| `copilot.port` | `8899` | Copilot relay port |
| `copilot.harvestDir` | `%USERPROFILE%\copilot-probe` | Harvested token, request template, and refresh transcripts |
| `copilot.tools.allow` | `["read", "write"]` | Tools handed to the Copilot channel. The chatHub request carries no `tools` field, so the tool list exists only as prompt text and the model has exactly what the list names; an empty list makes the channel plain text generation |
| `xiaoyi.enabled` | `false` | Start the Huawei Celia relay. Off by default: it needs the Huawei “AI Space” app running with its chat page open |
| `xiaoyi.port` | `8123` | Celia relay port |
| `xiaoyi.python` | auto-detected | Interpreter used to run `bridge/xiaoyi-harvest.py`; empty means look under `%LOCALAPPDATA%\Programs\Python` and on `PATH` |
| `xiaoyi.cacheFile` | `%LOCALAPPDATA%\xiaoyi-bridge\auth.json` | Cached Celia cookies, refreshed automatically when the upstream rejects them. A cookie older than 24 hours is reported as stale by `/health` |
| `deps.autoStart` | `true` | Start a companion application that is installed but not running |
| `deps.autoRefreshToken` | `false` | Refresh the token at boot when it is stale. Off by default: the script writes the machine's system-proxy registry keys for about a minute, behind the proxy client's back, which desynchronizes the client's idea of who owns the system proxy |
| `deps.autoRefreshWhileRunning` | `false` | Let the relay replace a stale token during use. Off by default: one refresh redirects the whole machine's system proxy at the interception proxy for about a minute, so any other outbound traffic — including the other relay — fails while it runs |
| `deps.bootstrap` | `true` | Copy the shipped harvest files into the harvest directory at boot |
| `deps.autoInstallCa` | `true` | Import the interception certificate when it is not trusted yet |
| `deps.autoInstallMitm` | `true` | Start a background `pip install mitmproxy` when the proxy is missing |

A relay that fails to start logs one warning and leaves the other running; neither failure blocks host startup.

### Refreshing while the app runs

An access token lasts about an hour, and replacing one rewrites the file every request is reading, so the two operations are kept apart:

- **A request in flight is never interrupted.** The Copilot relay counts the requests currently holding the token, and a refresh does not start while that count is above zero. A request arriving in that window is served with the token already in use rather than made to wait behind its neighbour.
- **A refresh is never served through.** Once one starts, a request arriving before the new token lands waits for it instead of reading a file that is being replaced. The wait is bounded; if no newer token appears, the request proceeds with the existing one and the attempt is logged.

The trigger is the token's own age, read from the harvest file: a request that would go out with a token older than 45 minutes replaces it first, and the last request of a burst does the same on its way out so the next one does not have to wait. There is no idle timer — refreshing while nothing is using the relay would change the system proxy and drive the Copilot window for no benefit. A failed attempt is not retried for a minute, because whatever stopped it (Copilot closed, a prerequisite unmet) does not clear in seconds.

The relay owns these rules because it is the only place that knows what is in flight; the host injects the trigger, so an automatic refresh and the settings page's button take the same lock and cannot run together.

### The settings routes

Every route answers only under the composition's connection trust fence, and each answers one method. They carry facts and fixed codes, never prose: the refresh chain's operator diagnostics are Chinese-language text written for a log, so the browser chooses the guidance from its own dictionary.

| Route | Method | Answer |
|---|---|---|
| `/local-bridge/status` | `GET` | One snapshot: the three relays' listeners, the WorkBuddy and Copilot companion applications, the Copilot token's age, the Celia session cookie's age, the unmet refresh prerequisites, and whether an attempt holds the refresh lock |
| `/local-bridge/refresh` | `POST` | Whether a refresh process started, and a refusal code when it did not |
| `/local-bridge/log` | `GET` | The tails of both transcripts the last attempt wrote, each with its absolute path and whether the file holds more |

`POST /local-bridge/refresh` changes the Windows system proxy for about a minute and drives the Copilot window to send one message. It refuses off Windows, while the Copilot application is not running, while a prerequisite is unmet, while an earlier attempt holds the lock, and when the refresh script is missing.

Each transcript tail is bounded to 16 KiB: `refresh-token.ps1` rewrites the transcript on every attempt, while the PowerShell trace appends to one file forever, so the bound is what keeps a long-lived harvest directory from being shipped to the browser. A read cut mid-file drops the partial leading line, and a cut inside a character leaves valid text.

The two transcript filenames are `bridge/preflight.mjs`'s (`REFRESH_LOG_FILES`), not this package's: the module writes them, so it names them, and the control plane reads that name rather than guessing it.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin orchestrates; it implements no relay. Each relay is a zero-dependency Node module under `bridge/`, shipped and imported through a computed URL so a bundler never inlines it, and `bridge/preflight.mjs` owns every fact about the machine the refresh chain needs.

Two decisions are load-bearing:

- **The routes live in a child fiber.** `webServer` and `connection` are declared in a nested `ctx.inject`, not in the plugin's own `inject`. A composition with no web server still starts the relays, and a composition with no trust fence registers no route at all — a refresh must never be reachable by an unauthenticated caller.
- **The refresh decision is made here, the refresh work is not.** `bridge/preflight.mjs` exports the harvest probe, the application probe, the certificate probe, and the refresh trigger; this package's control plane reads those facts and decides which prerequisite codes are unmet. It never parses the operator prose those functions return.

`bridge/refresh-token.ps1` performs the refresh: it raises a local interception proxy, points the system proxy at it, drives the Copilot window to open a connection, harvests the access token from that connection's handshake, and restores the proxy in a `finally` block. A backup file makes a killed attempt recoverable at the next run. A proxy an earlier attempt left listening is reused only while it still runs the current harvest script; one started before that script was replaced is stopped and started again, because mitmproxy unloads a watched script when it changes and does not always load the replacement, leaving the port listening with nothing harvesting.

### The WorkBuddy model catalogue

The `wbcloud` relay passes `model` straight through to `https://www.workbuddy.ai/v2/chat/completions`, so every model id the account carries works — the concrete ones (the GPT-6 and GPT-5.6 families, Grok, Gemini, Kimi, GLM, MiniMax, DeepSeek, the Hunyuan preview) and the `Auto`/`Fast`/`Balanced`/`Primary` aliases the client resolves for the user. The ids are lower-case; the display names are not ids, and a display name is refused with `model [...] service info not found`.

The catalogue is not served by a public HTTP endpoint: the daemon spills the product config to a local file and the client reads it from `ACC_PRODUCT_CONFIG_PATH`. The relay reads the same file (`wbcloud.catalogDir`, default `%USERPROFILE%\.workbuddy-ai\cache`), takes the newest `acc-product-config-v3*.json` in it, and serves the text models at `/v1/models` — so the list follows the account instead of a list frozen in code. Models carrying `tags` are the media and agent-persona entries rather than chat models, and are left out. The DSH route declares the same models statically, because pi-ai has no dynamic model discovery: its `openai-completions` transport never calls `/v1/models`, so the route is what puts them in the model picker.

### Reasoning effort

The cloud reads OpenAI's `reasoning_effort` — `low`, `medium`, `high`, `xhigh`, `max` — so the relay forwards that field from the incoming request and leaves it out when the caller names none, which leaves the cloud to apply the model's own default effort. A request that names `off` is translated to the cloud's `none`; the literal `off` is refused with `400` and the parameter named `reasoning.effort`. A cloud rejection that names a parameter is reported with that parameter in the message, so a level the account no longer offers reads as "the cloud rejected `reasoning.effort`" instead of a bare "invalid request parameters".

The request's output cap follows the account's catalogue (`maxOutputTokens` per model) rather than a fixed number. Reasoning tokens and the answer share that cap, so a fixed one leaves a high effort no room to write the answer — the model thinks, spends the budget, and returns nothing.

That cap is then reduced to what the prompt leaves over: the cloud counts the prompt *and* the reserved output against the model's context window, so a request that fits on its own can still be refused because the relay reserved a full window's worth of output. The relay estimates the prompt's token count and reserves only the remainder (with a margin), which keeps a long conversation sendable instead of pushing it over the window.

An input the provider refuses comes back as `11133` with `extError.code: 400002` and `param: input`, and that one code covers two causes. Tool pairing is one: the provider refuses the whole request when a `tool_calls` entry has no `tool` result, or a `tool` result has no call — the shape a conversation takes after a turn was interrupted mid-tool, or after an earlier retry cut it. The relay repairs the pairing on every request (a call that never returned gets a `tool` message saying so; a result whose call is gone is dropped), so one interrupted turn no longer fails every later step. Size is the other: the relay retries the request unchanged once, then shortens the conversation — the last eight messages, then the last two — cutting at call boundaries so a slice never begins with a tool result, which would be refused for the pairing reason above.

The channel headers name the client version and the deployment shape, and both come from the account's own product config (`genieVersion` and `deploymentType` in the cached `acc-product-config-v3*.json`) — the same source the official client reads them from. The header set is the client's own: `X-Product` is the deployment shape (`SaaS`), `X-IDE-Name` is `WorkBuddy`, `X-Private-Data` is `true`, and the request carries the `x-requested-with`, `x-codebuddy-request`, `acp-connection-id` and B3 link-trace headers the client sends. A pinned version or a hand-written product name drifts as soon as the client auto-updates, and the cloud's channel check reads exactly these headers. `GET /health` reports the version and deployment shape in use.

A `400` with `code: 11128` means the cloud does not accept that invocation *at that moment*. Measured, it has nothing to do with the request size, the reasoning effort, or the channel headers: a 90-character prompt hits it, and it appears after a burst of requests and clears on its own minutes later. The account has a frequency and credit limit — the cloud says so plainly in another message ("usage exceeds frequency limit … you can switch to the other models") — and it reports the wall with different codes per model: `14003`/`no_capacity` ("Model busy. Please switch models or retry later") for the busy ones, `11128` for the others. So this is an account-side throttle, not a missing header. The relay re-harvests the token, waits 1.5 seconds and retries the same request once; it does not shorten the conversation, because the refusal says nothing about the request's content and a shortened conversation makes the model lose the work in progress. Every refusal is written to `%LOCALAPPDATA%\workbuddy-bridge\channel.log` with the request's shape (model, message count, prompt size, tool count, output cap, effort, how many tool results the repair dropped or added) and each attempt's message count and status, so the next refusal can be compared with a request that worked. `401`/`403` take the same retry path, which is what a rotated token needs.

### The Celia session cookie

The Celia relay has no login of its own: it reads the session cookies the Huawei “AI Space” app holds in the memory of its WebView2 renderer, and the account issues them only after the 小艺 chat page is open and a message has been sent. The harvest therefore depends on a desktop application the relay does not control, and the two states it can be in are reported separately — the app is not running (`no_app`), or it runs but holds no session cookie yet (`no_cookies`). Each answer names the action that changes the state, because the difference between the two is what the reader has to act on.

The harvester is a Python script, and Python writes its output in the console code page — GBK on a Chinese Windows install — while a Node child process is read as UTF-8. The relay runs the interpreter with `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, and decodes what comes back as UTF-8, falling back to GBK when the bytes are not valid UTF-8. Without that, the reason the cookie was missing arrived as replacement characters.

The cookies live for more than a day (measured at over 40 hours). The cache file calls them stale after 24 hours, and `/health` says so with the age, so the signal arrives before a request does. The relay keeps using the cookie until the upstream refuses it, and then harvests it again.

Huawei refuses a handshake with `400`, `401`, `403` or `407`, and only the body tells the cases apart: `{"errorCode":"40002","errorMsg":"token expire or illegal"}` means this session cookie is no longer accepted. The `407` reads like a proxy asking for credentials — and the Windows system proxy is the usual first suspect — so the relay reports the upstream's own reason rather than a bare status, names the action (open the 小艺 chat page in AI Space, send a message, sign in again when the page asks), and drops the refused session cookie from the cache so the next request harvests again. The persistent cookies (device id, app name, JSID, xyxp) stay in the cache, so a fresh sign-in does not start from scratch. `GET /health` reports the refusal as `lastRejection` with its status and message.

### Tool calls over a text-only upstream

Neither upstream offers function calling. The WorkBuddy gateway is an agent with its own tool allowlist that ignores the caller's tools — asking it to call one makes it reach for its own and fail — and the Copilot `chatHub` frame carries one plain-text prompt with no tool field. Both relays therefore bridge tools through text, in one shared module (`bridge/toolprompt.mjs`):

1. The request's `tools` are rendered into the prompt as a list plus an intent format: the model answers `{"bridge_tool_calls":[{"name":…,"arguments":{…}}]}`.
2. The reply is parsed back into OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Malformed JSON is repaired (unbalanced brackets, trailing commas, arguments misplaced at the wrapper level) and retried once with a repair prompt; a reply that still looks like a call but cannot be parsed becomes an explicit error rather than being passed off as a final answer, because a downstream agent would treat it as task completion.
3. A model trained with its own tool-call markup may ignore that format and emit what it was trained on — DeepSeek's `<｜DSML｜tool_calls>` family is the one seen in practice. Its `invoke`/`parameter` blocks are converted the same way, because otherwise the markup is streamed to the user as text and no tool runs. The delimiters are matched tolerantly: a relay hop mangles the fullwidth bar into a halfwidth one or doubles it, and a missing close tag still parses.
4. Prior tool turns are replayed into the next prompt — the assistant's expressed intent with its arguments, and each result between a matching start/end marker carrying its `tool_call_id`. Multi-line results are framed that way because a tool's own output can read like conversation, and an unframed block gets mixed into the answer.

Only how the prompt reaches the upstream differs between the two relays, which is why each stays a separate module. The Copilot relay keeps streaming ordinary answers: a reply whose opening looks like a tool call is held back until it can be decided, and everything else is sent as it arrives. The WorkBuddy relay buffers whenever tools are offered, because its upstream does not stream in the first place.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-local-bridge`](../../llm/llm-local-bridge/README.md) — the LLM routes these relays serve.
- [`dsh-host-webserver`](../webserver/README.md) — the route carrier and the index-render seam this plugin registers on.
- [`dsh-host-open-in-app`](../open-in-app/README.md) — the sibling host plugin whose route shape and trust fence this one follows.

<a id="model-experience"></a>
## Model Experience

None, as the plugin starts local processes and serves browser routes; it registers no prompt, tool schema, or Session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The whole refresh chain is Windows-only.** The probes, the script, the UI automation, and the certificate import all assume Windows; the routes report `process.platform` so the page can say so rather than failing obscurely.
- **The WorkBuddy token needs an elevated reader.** WorkBuddy 5.9.4 relaunches itself elevated, so every process in its tree runs at a high integrity level and `OpenProcess(PROCESS_VM_READ)` on them is refused to a medium-integrity reader. `bridge/workbuddy-token.py` therefore caches the harvested token under `%LOCALAPPDATA%\workbuddy-bridge\token.json` and, when its own scan is refused, relaunches an elevated copy of itself through the usual consent prompt; the elevated copy caches the token and the first process reads it back. The prompt therefore appears only when the cached token has expired, not per call, and a deployment where the user declines the prompt gets the original "no access token found" error.
- **The interception ports are fixed.** `bridge/refresh-token.ps1` listens on `8082` and tunnels through `127.0.0.1:7890` — the mixed port of the proxy client it ships against — and neither is configurable, because the control plane probes the same ports the script uses and a value that moved only one of them would report a checkout as ready when the chain cannot run.
- **A refresh is not awaited by the trigger.** The host starts a detached process and reports only that it started. The caller that needs the result — the relay, before serving a request — reads it back by polling the harvested token's timestamp, bounded by a deadline; progress the settings page shows comes from the lock file and that same timestamp.
- **Token refresh owns the machine's system proxy while it runs, so it is opt-in.** `refresh-token.ps1` writes the `ProxyEnable`/`ProxyServer` registry keys directly, which takes the setting away from whichever proxy client normally manages it; a client that then re-asserts or shuts its core down leaves the system proxy pointing at nothing and every node timing out. Both `deps.autoRefreshToken` and `deps.autoRefreshWhileRunning` therefore default to off, and the settings page button is how a refresh is normally run. Enabling either one also drives the Copilot window to send one message.
- **The relays are not probed for readiness.** A listener that binds proves nothing about the application behind it; the first request is what discovers an unauthenticated upstream.
- **Tool calls depend on recognising what the model emitted.** The bridge renders a tool list and accepts three shapes back: the `bridge_tool_calls` JSON it asks for, repairable variants of it, and the model's own DSML marker family. A model that invents a fourth shape produces prose instead of a call. Tool calls also arrive whole rather than as streamed fragments, because the payload has to be seen before it can be parsed.
- **The Copilot chatHub channel cannot carry tool calls at all.** Its request carries no `tools` field, so the tool list exists only as prompt text, and the model on the other end answers as the server-side agent persona the chatHub gives it: it looks for files, reports `FILE_NOT_FOUND`, or claims it created `/mnt/data/...` — it never emits the JSON. Measured against the live relay with a file that does exist: 27 tools and 2 tools each produced zero tool calls in eight tries, and three different prompt wordings, including one that spelled out the format and forbade simulating file access, changed nothing. The persona wins because our instructions arrive as the user message: the request has no system-prompt field (`plugins` is the built-in Bing search, `options` and `extraExtensionParameters` are empty). The channel is therefore a plain-text channel — use it for prose, and route anything that has to reach the disk to a channel with native function calling.
- **The text protocol is unreliable on the Copilot channel, and the tool list's size is not the reason.** The chatHub request carries no `tools` field, so the tools exist only as prompt text and the model has to write the JSON itself. The instruction now names the real tools and says that `bridge_tool_calls` is the JSON key rather than a tool name, and the request is asked up to three times with the matching reminder appended each round instead of once. Neither change makes the channel usable for tool calls — see the next entry for why. The channel also shares one harvested conversation with the installed instance, so two relays pointed at the same account compete for it.

### Dev Note

**Runtime invariant:** No companion is published. The package owns no independent event sequence or mutable data relation: its status read derives every value from the relay runtime modules, and its routes are covered by the composition-level suite in `tests/control-routes.spec.ts`.
