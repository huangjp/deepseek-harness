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

/** 一条 OpenAI 形态的消息（小艺通道还要认工具轮次）。 */
export interface XiaoyiMessage {
  role?: string
  content?: unknown
  /** 助手这一轮表达的调用意图。 */
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
  /** 工具执行结果对应的调用 id。 */
  tool_call_id?: string
}

/**
 * 把 OpenAI 的 messages 收敛成一段给小艺的提示词。
 *
 * 当前问题取最后一条真实用户输入；它之后的工具轮次（助手表达的调用意图 + 工具执行结果）
 * 原样回放，让 agent 多轮接得上；assistant 的普通正文与 harness 内部噪声丢弃；
 * 短 system 提示词才保留，最终长度硬顶在 4000 字符以内（小艺通道实测上限约 8000）。
 * @param messages - OpenAI 格式的对话，可缺省。
 * @returns 交给小艺的提示词；没有可用用户输入时返回空串。
 */
export function buildPrompt(messages?: XiaoyiMessage[]): string
