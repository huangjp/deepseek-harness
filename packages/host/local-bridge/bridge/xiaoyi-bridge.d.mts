/**
 * `xiaoyi-bridge.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/** 启动后的反代实例。 */
export interface XiaoyiBridge {
  host: string
  port: number
  server: unknown
  close: () => Promise<void>
}

/**
 * 启动小艺反代。
 * @param overrides - 宿主注入的配置覆盖（`server` / `auth` / `chat`）。
 * @returns 已监听的实例。
 */
export function startXiaoyiBridge(overrides?: Record<string, unknown>): Promise<XiaoyiBridge>

/** 停止由 `startXiaoyiBridge()` 启动的服务（幂等）。 */
export function stopXiaoyiBridge(): Promise<void>
