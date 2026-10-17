/**
 * `toolcalls.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里声明测试会静态引用的导出。
 */

/** 一条 OpenAI 风格的 tool_call。 */
export interface ParsedToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

/**
 * 解析模型自带的 DSML 工具调用标记。
 * @param text - 模型输出。
 * @returns 解析出的调用；没有标记时返回 null。
 */
export function parseDsmlToolCalls(text: string | undefined): ParsedToolCall[] | null

/**
 * 从模型输出里解析工具调用（自带标记优先，其次是我们约定的 bridge_tool_calls）。
 * @param text - 模型输出。
 * @returns 解析出的调用；不是工具调用时返回 null。
 */
export function parseToolCalls(text: string | undefined): ParsedToolCall[] | null

/**
 * 文本看起来是否在表达工具调用。
 * @param text - 模型输出。
 * @returns 是否像工具调用。
 */
export function looksLikeToolCallAttempt(text: string | undefined): boolean

/**
 * 提取文本里所有括号平衡的 JSON 对象子串。
 * @param text - 待扫描文本。
 * @returns 提取出的 JSON 对象子串。
 */
export function extractJsonObjects(text: string): string[]

/**
 * 生成若干"修复后的 JSON 候选"。
 * @param text - 待修复文本。
 * @returns 候选列表。
 */
export function repairJsonText(text: string): string[]
