/**
 * `preflight.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 *
 * 其余导出（`runPreflight` / `detectHarvest` / `bootstrapPayload` 等）由
 * `src/index.ts` 通过计算出的 URL **动态** import，不经过 TypeScript 的模块解析，
 * 因此无需在此重复声明。
 */

/** 解析 Windows PowerShell 的绝对路径，避免依赖调用方的 PATH。 */
export function resolvePowerShell(): string
