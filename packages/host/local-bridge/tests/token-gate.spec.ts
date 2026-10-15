/**
 * 令牌使用闸门的并发规则：还有请求在用令牌时不换，换令牌时新请求等它落地。
 *
 * 闸门不认识令牌文件，也不认识刷新脚本 —— 时间戳读者、触发动作、轮询间隔全部由
 * 测试掌握，所以这里不需要真的收割一次令牌，也没有真实等待。
 */

import { describe, expect, it, vi } from 'vitest'
import { createTokenGate, type TokenGateTriggerOutcome } from '../bridge/token-gate.mjs'

/** 现在（秒）。 */
const now = (): number => Math.floor(Date.now() / 1000)

/** 一次刷新触发的替身，附带它与请求进入的先后来。 */
interface Bench {
  readonly gate: ReturnType<typeof createTokenGate>
  readonly trigger: ReturnType<typeof vi.fn>
  /** 触发与进入发生的先后。 */
  readonly events: string[]
  readonly logs: string[]
  /** 把令牌时间戳换成新的读者。 */
  setStamp: (read: () => number) => void
}

/**
 * 一个可用的闸门加上它需要的记录。
 * @param overrides - 触发结果、等待上限与初始时间戳。
 * @returns 闸门、触发替身与记录。
 */
function bench(overrides: {
  stamp?: () => number
  started?: boolean
  refusal?: string | null
  triggerThrows?: boolean
  waitMs?: number
  retryMs?: number
} = {}): Bench {
  let read = overrides.stamp ?? now
  const events: string[] = []
  const logs: string[] = []
  const trigger = vi.fn(async (): Promise<TokenGateTriggerOutcome> => {
    events.push('trigger')
    if (overrides.triggerThrows === true) throw new Error('刷新进程起不来')
    return { started: overrides.started ?? true, refusal: overrides.refusal ?? null }
  })
  const gate = createTokenGate({
    readStamp: () => read(),
    staleSec: 45 * 60,
    waitMs: overrides.waitMs ?? 500,
    pollMs: 1,
    retryMs: overrides.retryMs ?? 60000,
    trigger,
    log: (message) => { logs.push(message) },
  })
  return { gate, trigger, events, logs, setStamp: (next) => { read = next } }
}

/** 一个已经陈旧一小时的时间戳。 */
const staleStamp = (): number => now() - 3600

describe('令牌使用闸门', () => {
  it('令牌新鲜时直接放行，不触发刷新', async () => {
    const b = bench()
    await b.gate.enter()

    expect(b.trigger).not.toHaveBeenCalled()
    expect(b.gate.state()).toEqual({ inFlight: 1, refreshing: false })
  })

  it('完全没有令牌时不触发刷新', async () => {
    // 没有令牌时刷新脚本自己也未必收割成功，反复触发只会白白改系统代理。
    const b = bench({ stamp: () => 0 })
    await b.gate.enter()

    expect(b.trigger).not.toHaveBeenCalled()
    expect(b.gate.state().inFlight).toBe(1)
  })

  it('令牌陈旧且空闲时，换到新令牌之后才放请求进去', async () => {
    let stamp = staleStamp()
    const b = bench({ stamp: () => stamp })

    const entering = b.gate.enter().then(() => { b.events.push('entered') })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    // 触发已经发生，但新令牌还没落盘 —— 请求必须还在等。
    expect(b.events).toEqual(['trigger'])

    stamp = now()
    await entering

    expect(b.events).toEqual(['trigger', 'entered'])
    expect(b.gate.state().inFlight).toBe(1)
  })

  it('还有请求在用令牌时不换', async () => {
    let stamp = now()
    const b = bench({ stamp: () => stamp })
    await b.gate.enter()
    expect(b.trigger).not.toHaveBeenCalled()

    // 第一个请求还没结束，令牌却已经陈旧 —— 仍然不能换：它正带着旧令牌建着连。
    stamp = staleStamp()
    await b.gate.enter()

    expect(b.trigger).not.toHaveBeenCalled()
    expect(b.gate.state().inFlight).toBe(2)
  })

  it('最后一个请求离开时把陈旧的令牌换掉', async () => {
    let stamp = now()
    const b = bench({ stamp: () => stamp, waitMs: 20 })
    await b.gate.enter()
    stamp = staleStamp()

    b.gate.leave()

    expect(b.trigger).toHaveBeenCalledTimes(1)
    expect(b.gate.state()).toEqual({ inFlight: 0, refreshing: true })
    await vi.waitFor(() => { expect(b.gate.state().refreshing).toBe(false) })
  })

  it('刷新期间到达的请求等同一份新令牌，且不会触发第二次刷新', async () => {
    let stamp = staleStamp()
    const b = bench({ stamp: () => stamp })

    const first = b.gate.enter()
    const second = b.gate.enter()
    expect(b.trigger).toHaveBeenCalledTimes(1)

    stamp = now()
    await Promise.all([first, second])

    expect(b.trigger).toHaveBeenCalledTimes(1)
    expect(b.gate.state()).toEqual({ inFlight: 2, refreshing: false })
  })

  it('刷新没能启动时不等待，直接放行', async () => {
    const b = bench({ stamp: staleStamp, started: false, refusal: 'copilot-not-running' })
    const before = Date.now()

    await b.gate.enter()

    expect(Date.now() - before).toBeLessThan(200)
    expect(b.trigger).toHaveBeenCalledTimes(1)
    expect(b.logs.join('\n')).toContain('copilot-not-running')
    expect(b.gate.state().inFlight).toBe(1)
  })

  it('等不到新令牌时按上限超时放行', async () => {
    // 时间戳永不前进：这就是刷新跑完却没收割到令牌的样子。
    const b = bench({ stamp: staleStamp, waitMs: 30 })

    await b.gate.enter()

    expect(b.logs.join('\n')).toContain('超时')
    expect(b.gate.state()).toEqual({ inFlight: 1, refreshing: false })
  })

  it('触发抛错不会把请求一起弄失败', async () => {
    const b = bench({ stamp: staleStamp, triggerThrows: true })

    await expect(b.gate.enter()).resolves.toBeUndefined()

    expect(b.logs.join('\n')).toContain('刷新过程异常')
    expect(b.gate.state().inFlight).toBe(1)
  })

  it('读令牌抛错不会把请求一起弄失败', async () => {
    const b = bench({
      stamp: () => { throw new Error('token.json 是半截的') },
    })

    await expect(b.gate.enter()).resolves.toBeUndefined()

    expect(b.trigger).not.toHaveBeenCalled()
    expect(b.logs.join('\n')).toContain('读令牌失败')
    expect(b.gate.state().inFlight).toBe(1)
  })

  it('多余地归还名额不会让计数变负', () => {
    const b = bench()
    b.gate.leave()
    b.gate.leave()
    expect(b.gate.state().inFlight).toBe(0)
  })

  it('刚刚失败过的刷新在冷却期内不再重试', async () => {
    // 失败原因（Copilot 没开、前置条件不齐）不会在几秒内自己消失；每个请求都去撞
    // 一次只是白跑一遍检测、白刷一遍日志。
    const b = bench({ stamp: staleStamp, started: false, retryMs: 60000 })

    await b.gate.enter()
    b.gate.leave()
    await b.gate.enter()

    expect(b.trigger).toHaveBeenCalledTimes(1)
  })

  it('冷却期过后会重新试一次', async () => {
    const b = bench({ stamp: staleStamp, started: false, retryMs: 0 })

    await b.gate.enter()
    b.gate.leave()
    await b.gate.enter()

    expect(b.trigger).toHaveBeenCalledTimes(2)
  })

  it('换新成功之后不再受冷却期影响', async () => {
    let stamp = staleStamp()
    const b = bench({ stamp: () => stamp, retryMs: 60000 })

    await b.gate.enter()
    b.gate.leave()

    // 刷新成功 = 时间戳前进；令牌新鲜了，冷却期自然不该再拦住任何判断。
    stamp = now()
    await b.gate.enter()
    expect(b.trigger).toHaveBeenCalledTimes(1)
  })

  it('停止后不再为等待中的刷新留定时器', async () => {
    // 反代停了，就没有人再需要这份新令牌；继续轮询只会把进程多留一次等待上限。
    const b = bench({ stamp: staleStamp, waitMs: 60_000 })

    const entering = b.gate.enter()
    await vi.waitFor(() => { expect(b.gate.state().refreshing).toBe(true) })
    b.gate.dispose()
    await entering

    expect(b.logs.join('\n')).toContain('反代已停止')
    expect(b.gate.state().refreshing).toBe(false)
  })

  it('停止后不再开始新的刷新', async () => {
    const b = bench({ stamp: staleStamp })

    b.gate.dispose()
    await b.gate.enter()

    expect(b.trigger).not.toHaveBeenCalled()
    expect(b.gate.state().inFlight).toBe(1)
  })
})
