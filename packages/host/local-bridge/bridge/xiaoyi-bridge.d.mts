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

/**
 * 把华为拒绝握手时的状态码与正文翻译成一句能照着做的提示。
 * @param status - 握手响应的 HTTP 状态码（华为用 400/401/403/407 拒绝凭据）。
 * @param body - 握手响应的正文，可能为空。
 * @returns 可以直接展示给用户的一句话。
 */
export function describeRejection(status: number, body?: string): string

/**
 * 判断一次握手失败是不是「这枚 xy_token 不再被华为认」。
 * @param err - 握手失败抛出的错误，带 `status` 与可选的 `body`。
 * @returns 凭证确定失效时为 true。
 */
export function isCredentialRejected(err?: { status?: number; body?: string }): boolean

/**
 * 作废 cookie 集合里的会话 cookie（xy_token），保留持久 cookie。
 * @param jar - 缓存里的 cookie 集合。
 * @returns 不含 xy_token 的 cookie 集合。
 */
export function dropSessionToken(jar: Record<string, string>): Record<string, string>

/**
 * 华为判定这枚 xy_token 失效时，把缓存里的会话 cookie 作废。
 *
 * 作废后 `ensureAuth()` 会重新收割，`/health` 也会如实报出「缺 xy_token」。
 */
export function invalidateSessionToken(): void
