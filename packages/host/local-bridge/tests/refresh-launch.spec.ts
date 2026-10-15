import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refreshCopilotToken, resolvePowerShell } from '../bridge/preflight.mjs'

/**
 * 触发 Copilot 刷新时，PowerShell 必须能被找到。
 *
 * 这里曾经写死 `'powershell.exe'` 交给系统去 PATH 里查 —— 而本模块跑在 Electron 的
 * Host 进程里，那个进程的 PATH 由启动它的父进程决定，并不保证包含
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0`。找不到时 `spawn` 走的是**异步**
 * ENOENT，调用方看不到，只会以为「刷新已触发」—— 表现为 mitmdump 从未启动、
 * 日志也一份没有。所以这里要求解析出绝对路径。
 */
describe('resolvePowerShell', () => {
  it('resolves an absolute executable path on Windows', () => {
    const resolved = resolvePowerShell()
    expect(typeof resolved).toBe('string')
    expect(resolved.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      // 绝对路径，而不是让系统去 PATH 里碰运气。
      expect(resolved).toMatch(/^[A-Za-z]:\\/u)
      expect(resolved.toLowerCase()).toMatch(/powershell\.exe$/u)
    }
  })

  it('does not depend on PATH', () => {
    // SystemRoot 是 Windows 的固定环境变量；即便 PATH 被裁剪成空，也必须能解析出来。
    const saved = process.env.PATH
    try {
      process.env.PATH = ''
      const resolved = resolvePowerShell()
      expect(resolved.length).toBeGreaterThan(0)
      if (process.platform === 'win32') expect(resolved).toMatch(/^[A-Za-z]:\\/u)
    } finally {
      process.env.PATH = saved
    }
  })
})

/**
 * 触发刷新时，被触发的脚本必须**真的跑起来**。
 *
 * 这里用一份只写标记文件的替身脚本走同一条触发路径。两个拼装缺陷都只表现为
 * 「刷新显示已触发，转录却一个字节都没有」：`'; '` 拼接把 `try`/`catch` 隔开会让
 * 整个 `-Command` 解析失败，`detached: true` 会让 PowerShell 立即以 0 退出且不执行
 * 任何东西。这两者都不会让 `spawn` 报错，`started` 照样是 true —— 只有断言脚本
 * 留下的痕迹才能拦住它们。
 */
describe('refreshCopilotToken', () => {
  it.skipIf(process.platform !== 'win32')('actually runs the script it launches', async () => {
    const harvestDir = await mkdtemp(join(tmpdir(), 'dsh-refresh-launch-'))
    const script = join(harvestDir, 'fixture.ps1')
    const marker = join(harvestDir, 'marker.txt')
    await writeFile(script, [
      '$ErrorActionPreference = "Stop"',
      `Set-Content -Path '${marker}' -Value 'ran' -Encoding UTF8`,
      '',
    ].join('\r\n'), 'utf8')
    try {
      const outcome = await refreshCopilotToken({ scriptPath: script, harvestDir })
      expect(outcome.started).toBe(true)
      await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true)
    } finally {
      // PowerShell may still hold the transcript open when the marker lands.
      await rm(harvestDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
    }
  }, 60_000)
})
