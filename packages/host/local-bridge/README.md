---
description: "The host plugin that starts the two locally bundled model relays and serves the status and token-refresh routes the settings page reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-local-bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-local-bridge` starts the two model relays bundled with the desktop installer as independent loopback listeners: the WorkBuddy relay on `127.0.0.1:8787` and the Microsoft Copilot relay on `127.0.0.1:8899`. Before either listens it runs a dependency preflight that starts the desktop applications behind them, deploys the harvest files, imports the interception certificate, and refreshes a stale Copilot access token. The same plugin serves the routes the “Local model services” settings page reads: one status snapshot of both relays, the trigger for a Copilot token refresh, and the tails of the transcripts that refresh writes.

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
| `backend` | `serve` | WorkBuddy model channel: the client gateway, the CodeBuddy CLI, or any OpenAI-compatible endpoint |
| `cacheDir` | system temp | Gateway credential cache; the install directory is usually not writable |
| `copilot.enabled` | `true` | Start the Copilot relay |
| `copilot.port` | `8899` | Copilot relay port |
| `copilot.harvestDir` | `%USERPROFILE%\copilot-probe` | Harvested token, request template, and refresh transcripts |
| `deps.autoStart` | `true` | Start a companion application that is installed but not running |
| `deps.autoRefreshToken` | `true` | Refresh the token at boot when it is stale |
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
| `/local-bridge/status` | `GET` | One snapshot: both relays' listeners and companion applications, the Copilot token's age, the unmet refresh prerequisites, and whether an attempt holds the refresh lock |
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

`bridge/refresh-token.ps1` performs the refresh: it raises a local interception proxy, points the system proxy at it, drives the Copilot window to open a connection, harvests the access token from that connection's handshake, and restores the proxy in a `finally` block. A backup file makes a killed attempt recoverable at the next run.

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
- **The interception ports are fixed.** `bridge/refresh-token.ps1` listens on `8082` and tunnels through `127.0.0.1:7890` — the mixed port of the proxy client it ships against — and neither is configurable, because the control plane probes the same ports the script uses and a value that moved only one of them would report a checkout as ready when the chain cannot run.
- **A refresh is not awaited by the trigger.** The host starts a detached process and reports only that it started. The caller that needs the result — the relay, before serving a request — reads it back by polling the harvested token's timestamp, bounded by a deadline; progress the settings page shows comes from the lock file and that same timestamp.
- **`deps.autoRefreshToken` is on by default and its side effects are not silent.** It changes the system proxy for about a minute, and drives the Copilot window to send one message; the certificate import shows one Windows security prompt that cannot be suppressed.
- **The relays are not probed for readiness.** A listener that binds proves nothing about the application behind it; the first request is what discovers an unauthenticated upstream.
- **Tool calls depend on recognising what the model emitted.** The bridge renders a tool list and accepts three shapes back: the `bridge_tool_calls` JSON it asks for, repairable variants of it, and the model's own DSML marker family. A model that invents a fourth shape produces prose instead of a call. Tool calls also arrive whole rather than as streamed fragments, because the payload has to be seen before it can be parsed.

### Dev Note

**Runtime invariant:** No companion is published. The package owns no independent event sequence or mutable data relation: its status read derives every value from the relay runtime modules, and its routes are covered by the composition-level suite in `tests/control-routes.spec.ts`.
