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
  /** 渠道校验会看这个 UA；留空则按解析到的客户端版本拼。 */
  userAgent?: string
  /** 官方客户端的版本，写进渠道头；留空则用产品配置里的版本。 */
  clientVersion?: string
  /** 部署形态，写进 `X-Product`；留空则用产品配置里的部署形态。 */
  deploymentType?: string
  /** 企业 id，写进 `X-Enterprise-Id`/`X-Tenant-Id`；留空则用产品配置里的值。 */
  enterpriseId?: string
  /** 收割脚本路径；留空则用同目录的 `workbuddy-token.py`。 */
  harvestScript?: string
  /** 运行收割器的解释器；留空则自动探测。 */
  python?: string
  /** 账号模型目录的缓存目录；留空则用客户端的默认目录。 */
  catalogDir?: string
  /** 请求里的 max_tokens。 */
  maxTokens?: number
  /** 请求里的 temperature。 */
  temperature?: number
}

/** 一次调用的结果。 */
export interface WorkBuddyCloudResult {
  /** 模型输出的正文。 */
  text: string
  /** 原生 function calling 解析出来的调用；没有则 null。 */
  toolCalls: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }> | null
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

/** 一条 OpenAI 形态的对话消息；云端只认这几个字段。 */
export interface WorkBuddyChatMessage {
  role?: string
  content?: unknown
  /** assistant 发起的工具调用；每个 `id` 都要有一条 `tool_call_id` 相同的 tool 消息。 */
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>
  /** tool 消息对应的调用 id。 */
  tool_call_id?: string
}

/** 一次调用的入参。 */
export interface WorkBuddyCloudCall {
  /** OpenAI 形态的完整消息；给了就优先用它。 */
  messages?: WorkBuddyChatMessage[]
  /** 没有 messages 时用它拼出 system 轮。 */
  systemPrompt?: string
  /** 没有 messages 时用它拼出 user 轮。 */
  prompt?: string
  /** OpenAI 形态的 tools；给了就走**原生** function calling。 */
  tools?: Array<Record<string, unknown>>
  /** OpenAI 的 tool_choice。云端只收字符串；对象形态会被丢掉。 */
  toolChoice?: string | Record<string, unknown>
  /** 模型名；留空则用配置里的默认模型。 */
  model?: string
  /** 推理强度（`low`/`medium`/`high`/`xhigh`/`max`）。 */
  reasoningEffort?: string
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

/** 账号模型目录里的一条。 */
export interface WorkBuddyCatalogModel {
  /** 云端认的模型 id（小写）。 */
  id: string
  /** 客户端里显示的名字。 */
  name: string
  /** 倍率文本，例如 `x6.67`。 */
  credits: string
  /** 是否接受图片输入。 */
  supportsImages: boolean
  /** 是否接受工具调用。 */
  supportsToolCall: boolean
  /** 一次最多能输出多少 token；目录里没有就是 0。 */
  maxOutputTokens: number
  /** 输入额度，也就是这个模型的上下文窗口；目录里没有就是 0。 */
  maxInputTokens: number
  /** 账号目录里这个模型提供的推理档位。 */
  supportedEfforts: string[]
  /** 这个模型能不能关掉思维。 */
  canDisableThinking: boolean
}

/**
 * 从客户端缓存的产品配置里读出账号的文本模型。
 * @param dir - 产品配置缓存目录；留空则用客户端的默认目录。
 * @returns 账号的文本模型；读不到时返回空数组。
 */
export declare function readCatalogModels(dir?: string): WorkBuddyCatalogModel[]

/**
 * 把工具调用与工具结果修成成对的样子。
 *
 * 有结果没调用、有调用没结果，云端一律回 `11133 / 400002 / param: input`。
 * 补出来的结果是一条说明（「这次调用没有结果，需要就重跑」），不是编造的工具输出。
 * @param messages - 完整对话。
 * @returns 修好之后的对话，以及被去掉、被补出来的结果条数。
 */
export declare function repairToolPairing(
  messages: WorkBuddyChatMessage[],
): { messages: WorkBuddyChatMessage[]; dropped: number; synthesized: number }

/**
 * 把对话裁短一截：留下系统提示与最近的几条。
 *
 * 起点落在工具结果上时往回退到发起它的 assistant 消息 —— 只剩工具结果的切片
 * 会被云端以输入被拒作废。
 * @param messages - 完整对话。
 * @param keep - 保留最近几条非系统消息（工具调用整组会多留几条）。
 * @returns 裁短后的对话；不需要裁时原样返回。
 */
export declare function trimMessages(
  messages: WorkBuddyChatMessage[],
  keep?: number,
): WorkBuddyChatMessage[]

/**
 * 粗估一段提示词的 token 数。
 * @param chars - 字符数。
 * @returns 估算的 token 数。
 */
export declare function estimateTokens(chars: number): number

/**
 * 云端这次是不是「输入被拒」（提示词超了模型上下文窗口）。
 * @param raw - 云端返回的响应体。
 * @returns 是输入被拒时为 true。
 */
export declare function isInputRejected(raw: string): boolean

/**
 * 把推理强度写成云端认的形式。
 * @param effort - 调用方给的强度；`off` 会被翻成云端的 `none`。
 * @returns 写进请求体的值；没有强度时是 undefined。
 */
export declare function normalizeReasoningEffort(effort: string | undefined): string | undefined

/** 渠道身份：云端据它判断「这是不是官方客户端」。 */
export interface WorkBuddyChannelIdentity {
  /** 部署形态，写进 `X-Product`。 */
  deploymentType: string
  /** 客户端版本，写进 `X-IDE-Version` 与 User-Agent。 */
  clientVersion: string
  /** 云端地址。 */
  endpoint: string
  /** 企业 id，个人账号为空串。 */
  enterpriseId: string
}

/**
 * 从账号的产品配置里读出渠道身份。
 * @param dir - 产品配置缓存目录；留空则用客户端的默认目录。
 * @returns 渠道身份；读不到时各项为空串。
 */
export declare function readChannelIdentity(dir?: string): WorkBuddyChannelIdentity

/**
 * 云端这次是不是「渠道校验被拒」（400 + code 11128）。
 * @param raw - 云端返回的响应体。
 * @returns 是渠道校验拒绝时为 true。
 */
export declare function isChannelRejection(raw: string): boolean

/** 探测不到已安装客户端时使用的版本号。 */
export declare const PINNED_CLIENT_VERSION: string

/** 读不到产品配置时使用的部署形态。 */
export declare const DEFAULT_DEPLOYMENT_TYPE: string

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

  /**
   * 这个模型一次最多能输出多少 token。
   * @param model - 模型 id。
   * @param promptChars - 提示词的字符数；云端把输入与预留输出一起算进窗口，所以要按它收一收。
   * @returns 账号目录里这个模型的输出上限（按提示词占的位置收过）；目录里没有就用配置的默认值。
   */
  outputTokensFor(model: string, promptChars?: number): number

  /** 构造渠道头。 */
  buildHeaders(options: { token: string; uid: string; model: string }): Record<string, string>

  /** 发请求。 */
  post(body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response>

  /** 发请求，网络层失败时自动重试。 */
  postWithRetry(
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    attempts?: number,
  ): Promise<Response>

  /** 把网络层失败映射成带诊断信息的异常。 */
  mapNetworkError(err: Error | null): Error & { code?: string; httpStatus?: number; retriable?: boolean }

  /** 拿一份可用 token（内存缓存优先，否则重新收割）。 */
  ensureToken(force?: boolean): Promise<{ ok: boolean; token: string; uid: string; expiresAt: number }>

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
    messages?: WorkBuddyChatMessage[]
    systemPrompt?: string
    prompt?: string
  }): Array<{ role: string; content: unknown }>
}
