# Agent Note: 交付组合的 shell 进程卫生与两个上游缺口

Status: proposed

[English](2026-11-25-shell-process-hygiene-and-upstream-gaps.md) | 中文

## Problem

一位用户报告说他另一台电脑上的 PowerShell 打不开，怀疑是 Harness 漏下了没关闭的 shell。排查结论是一次性命令路径没有泄漏：每条一次性命令都跑在 Windows Job Object 里的私有 runner 上，整棵进程树随那个 runner 一起消失。但确实存在三个缺口，且没有一个能从单条命令触发。

会话内部，在有后台 job 注册表时，前台 `pwsh` 工具不装杀进程截止线。命令超过超时时间后会被提升成后台 job，shell 一直活到它自己跑完或被 `job_kill` 停掉；没人读这些 job 时，没有任何机制回收它们。交付的组合现在用配置关掉这条路径：`tool-pwsh` 行上 `promoteOnTimeout: false`、执行器默认超时 10 分钟、每个 owner 并发后台 job 4 个。

应用退出之后，还有两条路径会留下进程。Windows ConPTY 会话不在 Job 管控内 —— `packages/subprocess/subprocess-local/src/index.ts` 里就是这么写的 —— 所以硬退出会留下 PTY 的 `pwsh.exe` 与 `conhost.exe`。stdio MCP 服务器由 MCP SDK 拉起，只有优雅关闭才会死，硬退出同样会留下它们。

fork 自己的 Copilot 收割脚本还有第四个缺口：它把系统代理指向自己的拦截端口，并在 `finally` 里还原；被强杀的那一轮会把机器留在一个没人监听的端口上。该脚本现在会拉起一个看门狗进程，被强杀的那一轮进程一退出，它就把代理还原回去。

## Proposal

fork 一侧的缓解措施留在配置和 fork 自有的包里；需要改上游源码的那两个缺口交给上游。

1. 让 Windows ConPTY 会话与 stdio MCP 服务器进入 Job 管控，做法和一次性命令一样。ConPTY 会话跑在带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object 里，MCP stdio 服务器由一个在 Harness 退出时终止其进程树的 runner 拉起。
2. 给终端与 PTY 会话加空闲超时和每个 owner 的会话上限，使长驻会话不会永远留着 shell。`packages/api/terminal-controller` 已经给它自己创建的终端设了上限；终端服务本身既没有上限，也没有空闲回收。

两项都归上游，因为它们改的是上游包，而 fork 经常合并上游。

## Alternatives considered

**在 fork 自己的插件里补上清理。** 否决：残留进程来自上游包（`subprocess-local`、`mcp-client`），fork 本地的包装每次合并都得绕着它们打补丁。

**认定这次报告没有依据，什么都不改。** 否决：报告指出的确实是一类真实残留，而关掉日常使用能触发的那个缺口并不花钱。

**启动时杀掉所有父进程是 Harness 的进程。** 否决：这样第二个应用实例会杀掉第一个实例的 shell，机器上其它进程也不归应用管。

**只缩短执行器超时，不关提升。** 否决：更短的超时会杀掉更多长命令，却没移除提升路径，而正是提升路径让 shell 活过截止线。

## Acceptance criteria

- Harness 非优雅退出后，ConPTY 会话的 `pwsh.exe` 与 `conhost.exe` 都不在。
- Harness 非优雅退出后，stdio MCP 服务器的进程都不在。
- 空闲超过超时的终端会话被关闭；启动超过上限的会话被拒绝，且提示里写明上限。
- 两个上游 pull request 写明 Windows Job Object 行为、空闲超时与上限，并各自带一个在当前代码上会失败的测试。

## Risks

**给 ConPTY 加 Job 管控会改变会话的收尾方式。** 硬杀取代优雅关闭，PTY 自己的清理可能不执行；提案接受这一点，因为另一种结果是泄漏一棵进程树。

**空闲超时可能关掉用户仍认为活着的会话。** 超时必须覆盖一次长时间的工具调用，并且能按 profile 配置。

**会话上限会拒绝过去能启动的工作。** 拒绝提示必须写明上限并说明该关掉哪些会话，就像后台 job 注册表已经做的那样。
