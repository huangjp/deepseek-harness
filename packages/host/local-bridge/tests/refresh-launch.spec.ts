import { describe, expect, it } from 'vitest'
import { resolvePowerShell } from '../bridge/preflight.mjs'

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
