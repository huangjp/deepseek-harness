/**
 * `netdiag.mjs` 是随包分发的纯 JavaScript（Node 标准库、零依赖），
 * 这里只声明测试会静态引用的导出。
 */

/** 出站栈信息。 */
export interface SocketStack {
  /** WebSocket 实现来源：`node-undici` 直连，`chromium` 会读系统代理，`unknown` 认不出。 */
  impl: string
  /** 进程里实际存在的代理环境变量。 */
  proxyEnv: Record<string, string>
}

/** Windows 系统代理设置。 */
export interface SystemProxy {
  /** 系统代理是否开启。 */
  enabled: boolean
  /** 系统代理服务器串，例如 `127.0.0.1:7890`。 */
  server: string
  /** 绕过列表。 */
  bypass: string
}

/** 系统代理的探测结果。 */
export interface SystemProxyProbe extends SystemProxy {
  /** 代理端口现在通不通；没有开启代理或拆不出地址时是 null。 */
  reachable: boolean | null
  /** 从系统代理串里拆出来的地址。 */
  endpoint: { host: string; port: number } | null
}

/** 认出当前进程里的 WebSocket 是谁实现的。 */
export declare function describeSocketStack(): SocketStack

/** 读 Windows 系统代理设置（WinINET）。 */
export declare function readSystemProxy(): SystemProxy

/** 探测一个 host:port 现在通不通。 */
export declare function probeTcp(host: string, port: number, timeoutMs?: number): Promise<boolean>

/** 把系统代理里的 `host:port` 拆开。 */
export declare function parseProxyEndpoint(server: string): { host: string; port: number } | null

/** 生成一句人话，说明这次失败可能是什么造成的。 */
export declare function formatProxyDiagnosis(stack: SocketStack, proxy: SystemProxyProbe): string

/** 探测 Windows 系统代理是否真的可达。 */
export declare function probeSystemProxy(): Promise<SystemProxyProbe>
