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

/**
 * 把 OpenAI 的 messages 收敛成一段给小艺的提示词。
 *
 * 只保留最后一条真实用户输入，丢弃 assistant 历史与 DSH harness 注入的内部噪声，
 * 短 system 提示词才保留，最终长度硬顶在 4000 字符以内（小艺通道实测上限约 8000）。
 * @param messages - OpenAI 格式的对话，可缺省。
 * @returns 交给小艺的提示词；没有可用用户输入时返回空串。
 */
export function buildPrompt(messages?: Array<{ role?: string; content?: unknown }>): string
