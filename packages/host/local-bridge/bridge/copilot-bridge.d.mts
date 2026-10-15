/**
 * `copilot-bridge.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/** 启动后的反代实例。 */
export interface CopilotBridge {
  host: string
  port: number
  server: unknown
  close: () => Promise<void>
}

/**
 * 启动 Copilot 反代。
 * @param overrides - 宿主注入的配置覆盖，以及可选的刷新触发能力。
 * @returns 已监听的实例。
 */
export function startCopilotBridge(overrides?: Record<string, unknown>): Promise<CopilotBridge>

/** 停止由 `startCopilotBridge()` 启动的服务（幂等）。 */
export function stopCopilotBridge(): Promise<void>
