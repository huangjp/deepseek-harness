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
  /** 扁平形状：DSH 那边发过来的是 `{name, description, parameters}`，没有 function 包装。 */
  name?: string
  description?: string
  parameters?: unknown
}

/** 归一化后的工具定义。 */
export interface ToolSpec {
  /** 工具名。 */
  name: string
  /** 工具说明。 */
  description: string
  /** 参数 schema。 */
  parameters: { type?: string; properties?: Record<string, unknown>; [key: string]: unknown }
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

/** 模型拒绝执行工具任务时的重试提示。 */
export const TOOL_CALL_REFUSAL_REMINDER: string

/**
 * 归一化 tools —— 同时认 OpenAI 标准形状与 DSH 的扁平形状。
 * @param tools - OpenAI 风格或扁平形状的 tools 数组。
 * @returns 归一化后的清单。
 */
export function normalizeToolSpecs(tools: WireTool[] | undefined): ToolSpec[]

/**
 * 把 OpenAI tools 渲染成提示词里的清单与格式约定。
 * @param tools - OpenAI 风格或扁平形状的 tools 数组。
 * @param toolChoice - OpenAI 的 tool_choice。
 * @returns 提示词片段；没有可用工具时为空串。
 */
export function buildToolInstruction(tools: WireTool[] | undefined, toolChoice?: string): string

/**
 * 精简版工具清单 —— 给输入长度有硬上限的通道用。
 * @param tools - OpenAI 风格或扁平形状的 tools 数组。
 * @param toolChoice - OpenAI 的 tool_choice。
 * @returns 提示词片段；没有可用工具时为空串。
 */
export function buildCompactToolInstruction(tools: WireTool[] | undefined, toolChoice?: string): string

/**
 * 工具调用格式提示 —— 给已经拿到原生 tools 的通道追加。
 * @param tools - OpenAI 风格或扁平形状的 tools 数组。
 * @returns 提示词片段；没有可用工具时为空串。
 */
export function buildToolCallFormatHint(tools: WireTool[] | undefined): string

/**
 * 模型的输出是不是「拒绝执行工具任务」。
 * @param text - 模型输出。
 * @returns 是否像一次拒答。
 */
export function looksLikeToolRefusal(text: string | undefined): boolean

/**
 * 模型的输出是不是「声称完成了任务，但一次工具都没调」。
 * @param text - 模型输出。
 * @returns 是否像一次假完成。
 */
export function looksLikeFalseCompletion(text: string | undefined): boolean

/** 声称完成了却没调工具时的重试提示。 */
export const TOOL_REQUIRED_REMINDER: string

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
