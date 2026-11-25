# Agent Note: Shell process hygiene in the shipped profile and two upstream gaps

Status: proposed

English | [中文](2026-11-25-shell-process-hygiene-and-upstream-gaps.zh.md)

## Problem

A user reported that PowerShell would not start on one of their machines and suspected that the Harness left shells running. The investigation found no leak in the one-shot command path: every one-shot command runs in a private runner inside a Windows Job Object, and the whole process tree dies with that runner. Three gaps did show up, and none of them is reachable from a single command.

Inside a session, the foreground `pwsh` tool installs no kill deadline when a background-job registry is present. A command that passes its timeout is promoted to a background job that keeps its shell alive until it finishes on its own or `job_kill` stops it, and nothing reclaims those jobs when nobody reads them. The shipped profiles now close that path in configuration: `promoteOnTimeout: false` on the `tool-pwsh` rows, a ten-minute default executor timeout, and four concurrent background jobs per owner.

After the application dies, two paths still leave processes behind. Windows ConPTY sessions run outside Job containment — `packages/subprocess/subprocess-local/src/index.ts` says so — so a hard exit leaves the PTY's `pwsh.exe` and `conhost.exe` behind. stdio MCP servers are spawned by the MCP SDK and die only on a graceful close, so a hard exit leaves them behind as well.

The fork's own Copilot harvest script had a fourth gap: it points the system proxy at its interception port and restores it in a `finally` block, so a killed run left the machine pointing at a port nothing listened on. The script now starts a watchdog process that restores the proxy as soon as the killed run's process exits.

## Proposal

Keep the fork-side mitigation in configuration and in the fork's own packages, and take the two gaps that need upstream source changes to upstream.

1. Bring Windows ConPTY sessions and stdio MCP servers under Job containment, the way one-shot commands already are. A ConPTY session would run inside a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and an MCP stdio server would be spawned by a runner that terminates its tree when the Harness exits.
2. Give terminal and PTY sessions an idle timeout and a per-owner session cap, so a long-lived session does not keep shells alive forever. `packages/api/terminal-controller` already caps the terminals it creates; the terminal service itself has neither a cap nor an idle reaper.

Both changes belong upstream because they change upstream packages, and the fork merges upstream regularly.

## Alternatives considered

**Add the missing cleanup in a fork-local plugin.** Rejected: the leftover processes come from upstream packages (`subprocess-local`, `mcp-client`), and a fork-local wrapper would have to patch around them on every merge.

**Treat the report as unfounded and change nothing.** Rejected: the report named a real class of leftovers, and the configuration that closes the one gap reachable from ordinary use costs nothing.

**Kill every process whose parent is the Harness at startup.** Rejected: a second instance of the application would kill the first one's shells, and the other processes on the machine are none of the application's business.

**Lower the executor timeout instead of disabling promotion.** Rejected: a shorter timeout kills more long commands without removing the promotion path, and the promotion path is what keeps a shell alive past its deadline.

## Acceptance criteria

- A ConPTY session's `pwsh.exe` and `conhost.exe` are gone when the Harness exits without a graceful shutdown.
- A stdio MCP server's process is gone when the Harness exits without a graceful shutdown.
- A terminal session idle beyond its timeout is closed, and starting more sessions than the cap is refused with a message that names the cap.
- The upstream pull requests state the Windows Job Object behaviour, the idle timeout, and the cap, and each carries a test that fails on the current code.

## Risks

**Job containment for ConPTY changes how a session is torn down.** A hard kill replaces a graceful close, so the PTY's own cleanup may not run; the proposal accepts that because the alternative is a leaked process tree.

**An idle timeout closes sessions a user still considers live.** The timeout must cover a long tool call and stay configurable per profile.

**A session cap refuses work that used to start.** The refusal must name the cap and say which sessions to close, the way the background-job registry already does.
