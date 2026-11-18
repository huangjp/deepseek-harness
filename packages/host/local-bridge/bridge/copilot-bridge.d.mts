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

/**
 * 收敛工具清单时默认放行的工具名。
 */
export const DEFAULT_TOOL_ALLOW: string[]

/**
 * 按允许清单收敛工具数组。
 * @param tools - 请求带来的 OpenAI 风格或扁平工具数组。
 * @param allow - 放行的工具名。
 * @returns 放行的工具数组。
 */
export function filterTools(tools: unknown, allow: readonly string[]): unknown[]

/**
 * 这条通道本次放行的工具名。
 * @returns 放行的工具名。
 */
export function allowedTools(): string[]
