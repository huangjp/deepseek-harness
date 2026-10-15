---
description: "The “Local model services” settings page of the dsh web client: both bundled relays' listeners, the Copilot token's age, the refresh requirements, and the manual token refresh."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-local-bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-settings-local-bridge` is the “Local model services” page of the dsh web client. It reads two routes served by `@deepseek-ai/dsh-host-local-bridge` and shows both bundled relays: whether each is listening, whether the desktop application behind it is running, how old the harvested Copilot access token is, and which requirements a refresh is still missing. One confirmed action asks the host to refresh that token, and the page then reports the attempt's progress until a newer token arrives. The page writes no settings namespace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition that also mounts `@deepseek-ai/dsh-host-local-bridge`; the desktop app's `web-app` bundle mounts both. The page registers one `settings.section` entry, ordered after the Models page — the routes it reports on are the ones that page lists.

The page is read-only about the machine and its state lives where its owner put it: nothing here writes a settings namespace, and the host answers every fact.

### What the page shows

| Area | Reads |
|---|---|
| Each relay | Its loopback port, whether a connect succeeds, and whether the application behind it is running, installed-but-stopped, or absent |
| The Copilot token | When it was harvested, that age in the active language, and whether it is past the platform's one-hour lifetime |
| Refresh requirements | Four checks — the interception proxy, the harvest script, the upstream proxy, and the interception certificate — each with its remedy while unmet |
| The refresh action | One confirmed gesture, its progress while the host harvests, and its outcome once the token lands |

The action is offered only where the host would accept it: on Windows, with the Copilot application running, with every requirement met, and with no attempt already in flight. A refusal the host returns anyway is reported with the reason it names.

### Refusals

The host answers a refresh request with a fixed code, and the page chooses the sentence. A refusal with no code contradicts that contract and reads as a process that would not start.

| Code | Reported as |
|---|---|
| `unsupported-platform` | Refreshing is available on Windows only |
| `copilot-not-running` | Start the Copilot desktop app first |
| `prerequisites-missing` | A requirement above is unmet; the checklist names it |
| `busy` | A refresh is already running |
| `script-missing` | The refresh script is missing; restart the app to redeploy it |
| `spawn-failed` | The refresh process could not start |

<a id="understand-the-implementation"></a>
## Understand the implementation

Two decisions are load-bearing:

- **The page observes a refresh; it never waits for one.** A refresh is a detached one-to-two-minute process on the host, so the page shows a running notice while the host's lock is held, and keeps re-reading every five seconds until it can tell the attempt finished. Completion is read from two facts rather than from the lock alone: the lock outlives the process that took it, so a token harvested after the lock was claimed is what marks success. An attempt that ends without one is reported as a failure rather than as a silent success.
- **The wire is validated where it enters.** Every status response is checked field by field before it reaches render, so a payload this build cannot read becomes the page's failed state instead of rendering garbage. A prerequisite or refusal code this build does not know is dropped rather than failing the read, because a version skew must not blank the checklist the rest of the payload fills.

The page's status store coalesces nothing: a later read supersedes an earlier one still in flight, so a slow answer cannot overwrite a fresher snapshot, and disposal stops both polling and publishing.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-host-local-bridge`](../../host/local-bridge/README.md) — the host plugin that starts the relays and serves these routes.
- [`dsh-client-ui-settings`](../ui-settings/README.md) — the settings domain base whose `settings.section` seat this page fills.
- [`dsh-client-ui-settings-models`](../ui-settings-models/README.md) — the page before this one in the navigation, listing the routes these relays serve.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings page that reads relay status; it registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The page is Windows-only in practice.** Both relays and the refresh chain assume Windows; elsewhere the page says so and withholds the action rather than offering a control that always refuses.
- **A refresh cannot be cancelled or awaited.** The host starts a detached process, so the page can report that it started and then only observe; leaving the settings page does not stop it.
- **The upstream proxy is the user's own.** The refresh chain tunnels through `127.0.0.1:7890`, the mixed port of the client it ships against. The page reports that requirement as unmet, but it cannot configure a different one.
- **The refresh lock outlives the attempt.** The reminder notice clears when the token advances, so a failed attempt reads as a failure promptly; a second gesture inside the host's lock window is refused as busy rather than queued.
- **No progress beyond the token's timestamp.** The host exposes a transcript path, not a parsed progress stream, so the page cannot show which stage an attempt reached.

### Dev Note

**Runtime invariant:** No companion is published. The package owns one store whose snapshots are derived from the host's route answers; its behavior is covered by the controller and component suites beside it.
