/**
 * `child-output.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/**
 * 解开子进程的标准输出/错误输出。
 *
 * Python 按控制台代码页写 stdout（中文 Windows 上是 GBK），而 Node 默认按
 * UTF-8 解子进程的字节，所以先按 UTF-8 解一次，出现替换字符时再按 GBK 解一次。
 *
 * @param raw 子进程输出的字节或字符串
 * @returns 解好的文本；两种编码都解不出可用结果时返回 UTF-8 的结果
 */
export declare function decodeChildOutput(raw: Buffer | string): string

/**
 * 跑 Python 收割脚本时用的环境变量：让解释器写 UTF-8。
 *
 * @returns 带 `PYTHONIOENCODING` 与 `PYTHONUTF8` 的环境变量副本
 */
export declare function pythonUtf8Env(): NodeJS.ProcessEnv
