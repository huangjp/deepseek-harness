/**
 * `token-gate.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里声明测试会静态引用的导出。
 */

/** 闸门观察到的并发状态。 */
export interface TokenGateState {
  /** 正在使用令牌的请求数。 */
  inFlight: number
  /** 是否有刷新正在进行。 */
  refreshing: boolean
}

/** 一次刷新的启动结果；`started` 为 false 时 `refusal` 说明原因。 */
export interface TokenGateTriggerOutcome {
  started: boolean
  refusal?: string | null
}

/** 令牌使用闸门。 */
export interface TokenGate {
  /** 占用一个使用名额，并保证令牌已尝试换新。 */
  enter(): Promise<void>
  /** 归还一个使用名额。 */
  leave(): void
  /** @returns 当前并发状态。 */
  state(): TokenGateState
  /** 停掉等待中的刷新；反代停止时调用。 */
  dispose(): void
}

/**
 * 创建一个令牌使用闸门。
 * @param options - 读时间戳、陈旧阈值、等待上限与触发动作。
 * @returns 闸门。
 */
export function createTokenGate(options: {
  readStamp: () => number
  staleSec: number
  waitMs: number
  trigger: () => Promise<TokenGateTriggerOutcome>
  log?: (message: string) => void
  pollMs?: number
  retryMs?: number
}): TokenGate
