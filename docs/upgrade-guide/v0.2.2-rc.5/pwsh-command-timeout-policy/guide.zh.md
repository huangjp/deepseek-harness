---
kind: upgrade-guide
description: "交付的组合在命令超时后直接终止它，不再把它提升成后台 job，并把默认超时抬到 10 分钟。"
---

# 超过超时的 PowerShell 命令被终止，不再被提升成后台 job

[English](guide.md) | 中文

## 变更

本次构建交付的桌面与网页组合把 `pwsh` 工具配成 `promoteOnTimeout: false`，把 PowerShell 沙箱执行器配成 `timeoutMs: 600000`，并把后台 job 注册表配成 `maxConcurrentJobsPerOwner: 4`。

前台命令超过超时时间时，过去它会继续以后台 job 的形式运行，工具回报 `[still running after …; moved to background job <id>]`；现在它被终止，工具回报超时。请求未指定超时时间时，适用的超时从 2 分钟变为 10 分钟；后台 job 注册表每个 owner 接受的并发数从 10 变为 4；工具 schema 里 `timeoutMs` 的说明也改为「超时即终止命令」。

需要活过等待时间的工作用工具的 `run_in_background` 参数，它仍然返回 job id，也仍然受注册表每个 owner 的上限约束。

## 迁移

1. 接受新行为无需修改。确认：用 `pwsh` 以 `timeoutMs: 1000` 执行 `Start-Sleep -Seconds 30`，工具回报超时而不是后台 job id，且 `Get-Process pwsh` 看不到它留下的进程。
2. 要恢复上游的提升行为，在 `packages/bundle/web-app/presets/standard.patch.yml`、`packages/bundle/web-app/presets/ptc.patch.yml` 和 `packages/bundle/web-app/presets/cordis.patch.yml` 的 `tool-pwsh` 行里删掉 `config.promoteOnTimeout`。
3. 要恢复上游的超时与注册表上限，在 `packages/bundle/web-app/cordis.patch.yml` 的 `pwsh-sandbox` 行设 `config.timeoutMs: 120000`，在 `jobs` 行设 `config.maxConcurrentJobsPerOwner: 10`。确认：超过 2 分钟的命令又被提升成后台 job。
