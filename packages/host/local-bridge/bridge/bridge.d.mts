/**
 * `bridge.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/** 启动后的反代实例。 */
export interface WorkBuddyBridge {
  host: string
  port: number
  server: unknown
  close: () => Promise<void>
}

/**
 * 启动 WorkBuddy 反代。
 * @param overrides - 宿主注入的配置覆盖（`backend` / `server` / `serve` 等）。
 * @returns 已监听的实例。
 */
export function startBridge(overrides?: Record<string, unknown>): Promise<WorkBuddyBridge>

/** 停止由 `startBridge()` 启动的服务（幂等）。 */
export function stopBridge(): Promise<void>
