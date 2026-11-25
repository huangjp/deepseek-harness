---
kind: upgrade-guide
description: "The shipped profiles terminate a PowerShell command at its timeout instead of promoting it to a background job, and raise the default timeout to 10 minutes."
---

# A PowerShell command that passes its timeout is terminated instead of promoted

English | [中文](guide.zh.md)

## Change

The desktop and web profiles shipped by this build configure the `pwsh` tool with `promoteOnTimeout: false` and the PowerShell sandbox executor with `timeoutMs: 600000`, and the background-job registry with `maxConcurrentJobsPerOwner: 4`.

A foreground command that passes its timeout used to keep running as a background job, and the tool reported `[still running after …; moved to background job <id>]`; it is now terminated and the tool reports the timeout. The timeout before a request names one rises from 2 minutes to 10 minutes, the background-job registry accepts 4 concurrent jobs per owner instead of 10, and the `timeoutMs` description in the tool schema now states that the command is killed on expiry.

Work that must outlive the wait uses the tool's `run_in_background` parameter, which still returns a job id and is still bounded by the registry's per-owner limit.

## Migration

1. Accepting the new behaviour needs no change. Confirm: run a command that outlives its timeout — `pwsh` with `timeoutMs: 1000` on `Start-Sleep -Seconds 30` — and the tool reports a timeout instead of a background job id, and `Get-Process pwsh` shows no leftover process for it.
2. To restore the upstream promotion, remove `config.promoteOnTimeout` from the `tool-pwsh` row in `packages/bundle/web-app/presets/standard.patch.yml`, `packages/bundle/web-app/presets/ptc.patch.yml`, and `packages/bundle/web-app/presets/cordis.patch.yml`.
3. To restore the upstream timeout and registry limit, set `config.timeoutMs: 120000` on the `pwsh-sandbox` row and `config.maxConcurrentJobsPerOwner: 10` on the `jobs` row in `packages/bundle/web-app/cordis.patch.yml`. Confirm: a command that passes 2 minutes is again promoted to a background job.
