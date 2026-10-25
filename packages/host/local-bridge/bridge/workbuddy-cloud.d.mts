/**
 * `workbuddy-cloud.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/** 云端直连后端的配置。 */
export interface WorkBuddyCloudConfig {
  /** 云端地址；留空则用 `https://www.workbuddy.ai/v2/chat/completions`。 */
  endpoint?: string
  /** 默认模型名。 */
  model?: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
  /** 渠道校验会看这个 UA；换 WorkBuddy 版本后要跟着改。 */
  userAgent?: string
  /** 收割脚本路径；留空则用同目录的 `workbuddy-token.py`。 */
  harvestScript?: string
  /** 运行收割器的解释器；留空则自动探测。 */
  python?: string
  /** 请求里的 max_tokens。 */
  maxTokens?: number
  /** 请求里的 temperature。 */
  temperature?: number
}

/** 一次调用的结果。 */
export interface WorkBuddyCloudResult {
  /** 模型输出的正文。 */
  text: string
  /** 用量；云端没给就是 null。 */
  usage: Record<string, unknown> | null
  /** 云端直连没有会话概念，恒为 null。 */
  sessionId: string | null
  /** 云端直连拿不到成本，恒为 null。 */
  costUsd: null
  /** 本次调用耗时（毫秒）。 */
  durationMs: number
  /** 最后一个 SSE chunk 的原始内容。 */
  raw: unknown
  /** 模型的思维链（部分模型会给）。 */
  reasoning: string
}

/** 一次调用的入参。 */
export interface WorkBuddyCloudCall {
  /** OpenAI 形态的完整消息；给了就优先用它。 */
  messages?: Array<{ role?: string; content?: unknown }>
  /** 没有 messages 时用它拼出 system 轮。 */
  systemPrompt?: string
  /** 没有 messages 时用它拼出 user 轮。 */
  prompt?: string
  /** 模型名；留空则用配置里的默认模型。 */
  model?: string
  /** 超时（毫秒）。 */
  timeoutMs?: number
  /** 中止信号。 */
  signal?: AbortSignal
  /** 正文增量回调。 */
  onDelta?: (chunk: string) => void
}

/** 一个 SSE chunk 里抽出来的增量。 */
export interface WorkBuddyCloudChunk {
  /** 正文增量。 */
  content: string
  /** 思维链增量。 */
  reasoning: string
  /** 用量；只有最后一个 chunk 可能有。 */
  usage: Record<string, unknown> | null
}

/** 直连 WorkBuddy 云端的后端。 */
export declare class WorkBuddyCloudBackend {
  constructor(cfg?: WorkBuddyCloudConfig)

  /** 启动自检（含收割一次 token）。 */
  check(): Promise<{
    endpoint: string
    model: string
    harvestScript: string
    python: string
    ok: boolean
    uid?: string
    tokenExpiresAt?: number
    error?: string
  }>

  /** 一次模型调用。 */
  complete(options?: WorkBuddyCloudCall): Promise<WorkBuddyCloudResult>

  /** 构造渠道头。 */
  buildHeaders(options: { token: string; uid: string; model: string }): Record<string, string>

  /** 把云端的错误响应映射成带诊断信息的异常。 */
  mapError(status: number, raw: string): Error & { code?: string; httpStatus?: number; retriable?: boolean }

  /** 读 SSE 流。 */
  consumeSse(
    res: Response,
    onChunk: (chunk: WorkBuddyCloudChunk) => void,
  ): Promise<{ raw: unknown }>

  /**
   * 把 OpenAI 的 messages 规整成云端要的形状：第一条必须是 system。
   */
  static normalizeMessages(options: {
    messages?: Array<{ role?: string; content?: unknown }>
    systemPrompt?: string
    prompt?: string
  }): Array<{ role: string; content: unknown }>
}
