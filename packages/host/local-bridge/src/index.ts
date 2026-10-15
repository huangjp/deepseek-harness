/**
 * @deepseek-ai/dsh-host-local-bridge — 内置本地模型反代，随桌面安装包一起分发。
 *
 * 本包内嵌**两个**反代服务，各自独立监听：
 *   1. WorkBuddy 模型反代（`bridge/bridge.mjs`，默认 127.0.0.1:8787）——
 *      把本机已登录的 WorkBuddy 账号额度或 CodeBuddy CLI 反代成 OpenAI 兼容接口，
 *      两条对外路径：`POST /v1/chat/completions`（+3 别名）与 `POST /summarize`；
 *   2. Microsoft Copilot 反代（`bridge/copilot-bridge.mjs`，默认 127.0.0.1:8899）——
 *      复用 Copilot 桌面版已登录的 SignalR chatHub 通道，暴露 `POST /v1/chat/completions`。
 *
 * 两个反代分别依赖**用户自己安装的第三方应用**（WorkBuddy AI / Microsoft Copilot），
 * 本包不打包它们。所以启动顺序是：先跑依赖预检（`bridge/preflight.mjs`）——
 * 装了没跑就自动拉起来、没装就给出安装指引、Copilot 令牌陈旧且前置条件齐备就自动刷新 ——
 * 再起两个反代。顺序反过来只会让首批请求失败。
 *
 * 反代本体都是零依赖的纯 Node 标准库代码，位于本包的 `bridge/` 目录并随包发布；
 * 这里只负责编排生命周期：单个反代启动失败只记一条 warning，不影响另一个，
 * 也不阻断宿主启动；fiber dispose 时关掉全部监听。
 *
 * 图片投递：两条通道的上游都只接受**纯文本**（WorkBuddy 网关的 `userPrompt` 是 string；
 * Copilot 的 chatHub 协议无附件字段），所以图片按通道分别处理：WorkBuddy 的
 * `serve`/`cli` 后端把图片落盘、交上游 agent 自己读文件（`openai` 后端则按多模态
 * content 数组真透传）；Copilot 通道无法承载图片，收到图片时**显式报错**而不是静默丢弃。
 * @module @deepseek-ai/dsh-host-local-bridge
 */

import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { createLocalBridgeControl, type PreflightFacts } from './control.ts'
import { internals } from './internals.ts'
import {
  LOCAL_BRIDGE_LOG_PATH, LOCAL_BRIDGE_REFRESH_PATH, LOCAL_BRIDGE_STATUS_PATH,
  type LocalBridgeLogPayload, type LocalBridgeRefreshPayload, type LocalBridgeStatusPayload,
} from './shared.ts'

/** Stable Cordis plugin name. */
export const name = 'local-bridge'

/** 一个反代运行时模块的启动/停止函数名与入参。 */
interface BridgeSpec {
  /** 日志里用的中文标签。 */
  label: string
  /** 运行时模块的 `file://` URL（不能用裸 Windows 路径，ESM loader 会拒）。 */
  url: URL
  /** 导出的启动函数名。 */
  start: string
  /** 导出的停止函数名。 */
  stop: string
  /** 注入给启动函数的配置覆盖。 */
  overrides: Record<string, unknown>
}

/** 反代运行时模块的最小接口。 */
interface BridgeRuntime {
  start?: (overrides?: Record<string, unknown>) => Promise<{ host: string; port: number }>
  stop?: () => Promise<void>
}

/** 预检里单个应用的检测结果（仅取本文件用得到的字段）。 */
interface AppStatus {
  label: string
  installed: boolean
  running: boolean
  started: boolean
}

/** Plugin config. */
export interface Config {
  /** 是否随宿主启动内置反代。 */
  enabled: boolean
  /** 两个反代共用的监听地址；默认只对本机开放。 */
  host: string
  /** WorkBuddy 模型反代端口。 */
  port: number
  /** WorkBuddy 反代的模型通道：`serve`（客户端网关）/ `cli`（CodeBuddy CLI）/ `openai`（任意 OpenAI 兼容端点）。 */
  backend: string
  /** 网关凭据缓存目录；留空则落在系统临时目录（安装目录通常不可写）。 */
  cacheDir: string
  /** Microsoft Copilot 反代。 */
  copilot: {
    /** 是否启动 Copilot 反代（需先收割到令牌，否则只监听、调用会报 no_token）。 */
    enabled: boolean
    /** Copilot 反代端口。 */
    port: number
    /** 令牌/模板收割目录；留空则用 `%USERPROFILE%\copilot-probe`。 */
    harvestDir: string
  }
  /** 配套依赖（WorkBuddy AI / Microsoft Copilot）的自愈开关。 */
  deps: {
    /** 装了但没在跑时，是否自动把它们拉起来。 */
    autoStart: boolean
    /**
     * Copilot 令牌陈旧且前置条件齐备时，是否自动触发 `refresh-token.ps1`。
     * 注意：该脚本会**临时切换系统代理**（约 1 分钟，`finally` 里还原），
     * 并用 UI 自动化让 Copilot 建一次连接 —— 介意的话把它关掉。
     */
    autoRefreshToken: boolean
    /**
     * 启动时把随包分发的部署文件（收割插件、刷新脚本、请求模板）自举到收割目录。
     * 安装包带不了 mitmproxy / CA / 已登录的 Copilot，但这步能自动化 ——
     * 开着它，新机器上装完直接启动即可，不必单独跑部署脚本。
     */
    bootstrap: boolean
    /**
     * mitmproxy CA 未装入受信任根证书区时，是否自动导入。
     * 注意：会弹出**一次** Windows 安全警告 —— 这是导入根证书的系统强制确认，无法静默绕过。
     */
    autoInstallCa: boolean
    /** mitmdump 缺失时，是否在后台尝试 `pip install mitmproxy`（不阻塞启动，装完下次生效）。 */
    autoInstallMitm: boolean
  }
}

/**
 * 两个反代的默认监听端口。schema 默认值与控制面的端口探测读同一份常量，
 * 否则设置页会去探测一个与反代实际监听不同的端口。
 */
const DEFAULT_WORKBUDDY_PORT = 8787
const DEFAULT_COPILOT_PORT = 8899

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().default(DEFAULT_WORKBUDDY_PORT),
  backend: z.string().default('serve'),
  cacheDir: z.string().default(''),
  copilot: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(DEFAULT_COPILOT_PORT),
    harvestDir: z.string().default(''),
  }),
  deps: z.object({
    autoStart: z.boolean().default(true),
    autoRefreshToken: z.boolean().default(true),
    bootstrap: z.boolean().default(true),
    autoInstallCa: z.boolean().default(true),
    autoInstallMitm: z.boolean().default(true),
  }),
})

/** 动态导入一个 bridge/ 下的运行时模块（说明符由计算得出，避免被打包器内联）。 */
async function importRuntime(url: URL): Promise<Record<string, unknown>> {
  // `import()` 的静态类型是 `any`，这里直接窄化到运行时的模块命名空间；调用方
  // 各自在边界上校验自己用到的导出（见 `preflightFacts`）。
  return (await import(url.href)) as Record<string, unknown>
}

/**
 * 把打包环境下的 ASAR 虚拟路径改写成 ASAR 之外的真实磁盘路径。
 *
 * Electron 会给 `import.meta.url` 打上 `app.asar/` 前缀，而 `bridge/` 里有一批
 * **必须由外部进程读取**的文件：
 *   - `refresh-token.ps1` —— `powershell.exe` 用 `Get-Content` 读；
 *   - `token-harvester.py` —— `mitmdump --scripts` 加载；
 *   - `chat_template.json` 等 —— 自举时按普通文件拷贝到收割目录。
 * 这些进程完全不认识 ASAR，拿到 ASAR 里的路径只会静默失败：
 * `spawn()` 照样返回成功，于是预检报 `refresh.started=true`，
 * 但 mitmdump 从没起来、`token.json` 也永远不会出现。
 *
 * electron-builder 会把 `bridge/` 放进 `app.asar.unpacked`，所以这里的转换
 * 与 `electron-builder.config.mjs` 里的 `asarUnpack` 规则是**成对**的。
 * 非 ASAR 路径（源码运行、已解包目录）原样返回。
 *
 * @param filePath - 从 `import.meta.url` 推导出的文件系统路径。
 * @returns 外部进程可用的真实磁盘路径。
 */
export function resolveRealPath(filePath: string): string {
  // 只处理 Windows 打包产物；其它平台的 ASAR 由 Electron 内部处理，且外部工具一般不存在。
  // 同时接受两种分隔符：fileURLToPath 在 Windows 上返回反斜杠，但测试与非常规来源可能给出正斜杠。
  const marker = /([\\/])app\.asar\1/
  const match = marker.exec(filePath)
  if (!match) return filePath
  const separator = match[1]
  const head = filePath.slice(0, match.index)
  const tail = filePath.slice(match.index + match[0].length)
  return `${head}${separator}app.asar.unpacked${separator}${tail}`
}

/**
 * 加载预检模块的命名空间。
 *
 * 生产路径经计算出的 URL 动态导入；源码级测试可经 `internals` 换成一份替身，
 * 因为真模块会探测本机、启动 PowerShell，刷新时还会改系统代理。
 * @param url - `bridge/preflight.mjs` 的 `file://` URL。
 * @returns 模块命名空间。
 */
async function loadPreflightModule(url: URL): Promise<Record<string, unknown>> {
  return internals.preflight === undefined ? await importRuntime(url) : await internals.preflight()
}

/** 预检模块的最小接口。 */
interface PreflightModule {
  runPreflight: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/**
 * 绑定引导预检入口。
 * @param module - 动态 import 得到的模块命名空间。
 * @returns 预检入口。
 * @throws 当模块缺少 `runPreflight` 导出时。
 */
function preflightRunner(module: Record<string, unknown>): PreflightModule {
  const { runPreflight } = module
  if (typeof runPreflight !== 'function') {
    throw new Error('local-bridge: bridge/preflight.mjs 缺少 runPreflight 导出')
  }
  return { runPreflight: runPreflight as PreflightModule['runPreflight'] }
}

/**
 * 控制面读取的 `bridge/preflight.mjs` 导出。
 *
 * 该模块是随包分发的纯 JavaScript，经计算出的 URL **动态** import，TypeScript
 * 看不到它的形状，所以在模块边界上逐项校验，而不是断言一个未经验证的形状。
 *
 * @param module - 动态 import 得到的模块命名空间。
 * @returns 控制面读取的预检接口。
 * @throws 当模块缺少任一必需导出时。
 */
function preflightFacts(module: Record<string, unknown>): PreflightFacts {
  const { detectHarvest, detectAllApps, detectCa, refreshCopilotToken, REFRESH_LOCK_MS, REFRESH_LOG_FILES } = module
  const files = REFRESH_LOG_FILES as { transcript?: unknown; spawn?: unknown } | null | undefined
  if (typeof detectHarvest !== 'function' || typeof detectAllApps !== 'function'
    || typeof detectCa !== 'function' || typeof refreshCopilotToken !== 'function'
    || typeof REFRESH_LOCK_MS !== 'number'
    || typeof files?.transcript !== 'string' || typeof files.spawn !== 'string') {
    throw new Error('local-bridge: bridge/preflight.mjs 缺少控制面所需的导出')
  }
  return {
    detectHarvest: detectHarvest as PreflightFacts['detectHarvest'],
    detectAllApps: detectAllApps as PreflightFacts['detectAllApps'],
    detectCa: detectCa as PreflightFacts['detectCa'],
    refreshCopilotToken: refreshCopilotToken as PreflightFacts['refreshCopilotToken'],
    refreshLockMs: REFRESH_LOCK_MS,
    refreshLogFiles: { transcript: files.transcript, spawn: files.spawn },
  }
}

/** 本模块用到的连接信任面；完整的类型归浏览器侧的 connection 包所有。 */
interface LocalBridgeConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 组合的 connection 服务（类型写在本地：它的包属于浏览器侧）。 */
function connectionOf(ctx: Context): LocalBridgeConnection {
  return Reflect.get(ctx, 'connection') as LocalBridgeConnection
}

/** 一个 JSON 响应（no-store：反代与令牌状态都是实时事实）。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405，并声明该路由唯一支持的方法。 */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 设置页控制面路由所需的路径与端口。 */
interface ControlRouteOptions {
  /** 收割目录。 */
  harvestDir: string
  /** `refresh-token.ps1` 的真实磁盘路径。 */
  refreshScript: string
  /** WorkBuddy 反代端口。 */
  workbuddyPort: number
  /** Copilot 反代端口。 */
  copilotPort: number
  /** 预检模块的 `file://` URL。 */
  preflightUrl: URL
}

/**
 * 注册设置页读取状态、触发刷新所用的两条路由。
 *
 * 这两个服务写在这个**子 fiber** 的 inject 里，而不是插件自己的：反代本身与 web
 * 表面无关（没有 web server 的组合里它仍要照常监听），所以外层不等任何人；子 fiber
 * 等 `webServer` 与 `connection` 就位后再注册路由。没有信任闸门的组合因此永远不注册
 * —— 刷新会临时改系统代理并驱动 UI 自动化，绝不能暴露给未经鉴权的调用方。
 *
 * @param ctx - the Cordis context.
 * @param options - 收割目录、刷新脚本与预检模块的位置，以及两个反代端口。
 */
function registerControlRoutes(ctx: Context, options: ControlRouteOptions): void {
  ctx.inject(['webServer', 'connection'], (scope: Context) => {
    const control = createLocalBridgeControl({
      loadPreflight: async () => preflightFacts(await loadPreflightModule(options.preflightUrl)),
      refreshScript: options.refreshScript,
      harvestDir: options.harvestDir,
      workbuddyPort: options.workbuddyPort,
      copilotPort: options.copilotPort,
      // 预检的拒绝原因是给人看的操作提示，落日志；线上只传代码，文案由页面自己的字典出。
      log: (message) => { scope.logger.warn(message) },
    })
    /** 拒绝一个不可信或未鉴权的请求；已拒绝时返回 true。 */
    const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
      const rejection = connectionOf(scope).requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: LOCAL_BRIDGE_STATUS_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        const payload: LocalBridgeStatusPayload = await control.status()
        sendJson(res, 200, payload)
      },
    }), `local-bridge: GET ${LOCAL_BRIDGE_STATUS_PATH}`)

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: LOCAL_BRIDGE_REFRESH_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        const payload: LocalBridgeRefreshPayload = await control.refresh()
        sendJson(res, 200, payload)
      },
    }), `local-bridge: POST ${LOCAL_BRIDGE_REFRESH_PATH}`)

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: LOCAL_BRIDGE_LOG_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        const payload: LocalBridgeLogPayload = await control.log()
        sendJson(res, 200, payload)
      },
    }), `local-bridge: GET ${LOCAL_BRIDGE_LOG_PATH}`)
  })
}

/**
 * 启动内置的两个反代服务，并把关闭动作绑到插件 fiber 上。
 * @param ctx - the Cordis context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cacheDir = config.cacheDir || join(tmpdir(), 'dsh-local-bridge')
  const harvestDir = config.copilot.harvestDir || join(homedir(), 'copilot-probe')
  const preflightUrl = new URL('../bridge/preflight.mjs', import.meta.url)
  // 随包分发的部署文件就在 preflight.mjs 同目录；自举时从这里拷到收割目录。
  // 自举发生在 Electron 主进程内（asar-aware fs 能读），但为了与刷新脚本共用同一份
  // 真实磁盘文件，统一取解包后的路径，避免同一目录出现两份副本。
  const bridgeDir = resolveRealPath(fileURLToPath(new URL('../bridge/', import.meta.url)))
  // PowerShell 要的是文件系统路径，不是 file:// URL；而且必须是 **ASAR 之外**的真实路径，
  // 否则外部 powershell.exe 打不开它，刷新链路会静默失效。
  const refreshScript = resolveRealPath(fileURLToPath(new URL('../bridge/refresh-token.ps1', import.meta.url)))

  // 控制面不受 enabled 影响：反代关掉时设置页仍要能读到令牌与前置状态，
  // 用户才判断得出该不该把它打开。
  registerControlRoutes(ctx, {
    harvestDir,
    refreshScript,
    workbuddyPort: config.port,
    copilotPort: config.copilot.port,
    preflightUrl,
  })

  if (!config.enabled) return

  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {
    // 缓存目录建不出来只影响网关凭据复用，不阻断反代启动。
  }

  const specs: BridgeSpec[] = [
    {
      label: 'WorkBuddy 模型反代',
      url: new URL('../bridge/bridge.mjs', import.meta.url),
      start: 'startBridge',
      stop: 'stopBridge',
      overrides: {
        server: { host: config.host, port: config.port },
        backend: config.backend,
        serve: { cacheDir },
      },
    },
  ]
  if (config.copilot.enabled) {
    specs.push({
      label: 'Microsoft Copilot 反代',
      url: new URL('../bridge/copilot-bridge.mjs', import.meta.url),
      start: 'startCopilotBridge',
      stop: 'stopCopilotBridge',
      overrides: {
        server: { host: config.host, port: config.copilot.port },
        ...config.copilot.harvestDir ? { harvest: { dir: config.copilot.harvestDir } } : {},
      },
    })
  }

  ctx.effect(() => {
    void (async () => {
      // ---- 1) 依赖预检：先保证两个配套应用在跑、Copilot 令牌不过期 ----
      let preflight: Record<string, unknown> | null = null
      try {
        const mod = preflightRunner(await loadPreflightModule(preflightUrl))
        preflight = await mod.runPreflight({
          harvestDir,
          refreshScript,
          bridgeDir,
          autoStartDeps: config.deps.autoStart,
          autoRefreshToken: config.deps.autoRefreshToken,
          bootstrap: config.deps.bootstrap,
          autoInstallCa: config.deps.autoInstallCa,
          autoInstallMitm: config.deps.autoInstallMitm,
          log: (message: string) => { ctx.logger.info(message) },
        })
        const apps = (preflight.apps ?? {}) as Record<string, AppStatus>
        for (const status of Object.values(apps)) {
          if (status.running) {
            ctx.logger.info(`[预检] ${status.label}：${status.started ? '已自动启动' : '运行中'}`)
          } else {
            ctx.logger.warn(`[预检] ${status.label}：${status.installed ? '已安装但未运行' : '未检测到（未安装）'}`)
          }
        }
      } catch (error) {
        /* v8 ignore next -- a preflight rejects with an Error; a non-Error rejection cannot be staged */
        ctx.logger.warn(`依赖预检失败（不影响反代启动）：${error instanceof Error ? error.message : String(error)}`)
      }

      // 自举结果与 CA 状态要显式说出来 —— 否则用户只会看到「Copilot 反代不通」而不知为何。
      const boot = (preflight?.bootstrap ?? {}) as { copied?: string[]; repaired?: string[] }
      if (boot.copied?.length || boot.repaired?.length) {
        ctx.logger.info(`[预检] 已自举部署文件：新增 ${boot.copied?.length ?? 0} 个、修复 ${boot.repaired?.length ?? 0} 个`)
      }
      const ca = (preflight?.ca ?? {}) as { installed?: boolean }
      if (ca.installed === false) {
        ctx.logger.warn('[预检] mitmproxy CA 未装入受信任根证书区 —— Copilot 通道在导入前无法工作')
      }
      const mitm = (preflight?.mitmInstall ?? {}) as { started?: boolean; reason?: string }
      if (mitm.started === false && mitm.reason) {
        ctx.logger.warn(`[预检] mitmproxy 未就绪：${mitm.reason}`)
      }

      // ---- 2) 起两个反代，把预检结果带下去供 /health 展示 ----
      for (const spec of specs) {
        try {
          const mod = await importRuntime(spec.url)
          const start = mod[spec.start] as BridgeRuntime['start']
          /* v8 ignore next -- the shipped module exports its start function; this guards a mis-packaged build */
          if (typeof start !== 'function') throw new Error(`运行时模块缺少导出 ${spec.start}`)
          const started = await start({ ...spec.overrides, preflight })
          ctx.logger.info(`${spec.label} 已监听 http://${started.host}:${started.port}`)
        } catch (error) {
          /* v8 ignore next -- the relay runtimes reject with Error values; a non-Error rejection cannot be staged */
          ctx.logger.warn(`${spec.label} 启动失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    return async () => {
      for (const spec of specs) {
        try {
          const mod = await importRuntime(spec.url)
          const stop = mod[spec.stop] as BridgeRuntime['stop']
          /* v8 ignore next -- the shipped runtime modules export their stop function; the guard covers a mis-packaged build */
          if (typeof stop === 'function') await stop()
        } catch {
          // dispose 阶段不抛：关闭流程里再抛错只会污染其它 fiber 的回收。
        }
      }
    }
  }, 'local-bridge')
}
