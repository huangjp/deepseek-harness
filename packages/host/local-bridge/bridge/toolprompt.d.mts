/**
 * `toolprompt.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里声明测试会静态引用的导出。
 */

/** OpenAI 风格的工具定义（只声明本模块读到的字段）。 */
export interface WireTool {
  type?: string
  function?: {
    name?: string
    description?: string
    parameters?: unknown
  }
}

/** 一条 OpenAI 风格的 tool_call。 */
export interface WireToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** 一次模型输出判定后的结果。 */
export interface ToolOutcome {
  /** 解析出的调用；没有则为 null。 */
  calls: WireToolCall[] | null
  /** 作为正文下发的文本；判定为调用时为空。 */
  content: string
  /** 明显在表达工具调用但 JSON 写坏了 —— 调用方必须显式报错。 */
  broken: boolean
}

/** 流式闸门。 */
export interface ToolCallGate {
  /** @param delta - 本次增量。 @returns 此刻可以立即下发的文本。 */
  push(delta: string): string
  /** @param isCall - 收尾时判定的结果。 @returns 仍扣着、应作为正文补齐的文本。 */
  settle(isCall: boolean): string
}

/** 工具由外部持有并执行的通道声明。 */
export const EXTERNAL_TOOLING_NOTICE: string

/** JSON 写坏时的重试提示。 */
export const TOOL_CALL_REPAIR_REMINDER: string

/**
 * 把 OpenAI tools 渲染成提示词里的清单与格式约定。
 * @param tools - OpenAI 风格 tools 数组。
 * @param toolChoice - OpenAI 的 tool_choice。
 * @returns 提示词片段；没有可用工具时为空串。
 */
export function buildToolInstruction(tools: WireTool[] | undefined, toolChoice?: string): string

/**
 * 助手表达过的调用回放成对话文本。
 * @param content - 该条消息正文。
 * @param toolCalls - OpenAI 风格 tool_calls。
 * @returns 一行对话文本。
 */
export function toolCallTurnText(content: string, toolCalls: WireToolCall[]): string

/**
 * 工具执行结果回放成对话文本。
 * @param toolCallId - 对应的调用 id。
 * @param content - 结果正文。
 * @returns 一行对话文本。
 */
export function toolResultTurnText(toolCallId: string | undefined, content: string): string

/**
 * 消息带工具语义时的回放文本。
 * @param message - OpenAI 风格消息。
 * @param content - 已抽出的正文。
 * @returns 对话文本；没有工具语义时为 null。
 */
export function toolTurnText(
  message: { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: WireToolCall[] },
  content: string,
): string | null

/**
 * 判定一次模型输出是工具调用还是最终回答。
 * @param input - 输出全文与本次是否带工具。
 * @returns 判定结果。
 */
export function resolveToolOutcome(input: { text: string | undefined; hasTools: boolean }): ToolOutcome

/**
 * 解析失败时下发的错误文本。
 * @param text - 模型最后那次原始输出。
 * @returns 错误文本。
 */
export function toolCallFailureText(text: string | undefined): string

/**
 * 带工具的一次（必要时两次）非流式调用。
 * @param options - 上游调用、system prompt、是否带工具与日志。
 * @returns 判定结果、最后一次原文与用量。
 */
export function completeWithToolCalls(options: {
  invoke: (systemPrompt: string) => Promise<{ text: string; usage?: object }>
  systemPrompt: string
  hasTools: boolean
  log?: (message: string) => void
}): Promise<{ outcome: ToolOutcome; text: string; usage: object | undefined }>

/** @returns 流式通道上"边流边判"的闸门。 */
export function createToolCallGate(): ToolCallGate
