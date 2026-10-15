/**
 * Locale bundles for the local-model-relay settings page.
 *
 * Every refusal and prerequisite the host reports travels as a fixed code, so
 * the guidance a user acts on is chosen here rather than returned as host
 * prose. `{name}` placeholders are filled by the shared translate seat.
 */

/** Locale keys the page renders. */
export type LocalBridgeLocaleKey =
  | 'nav' | 'title' | 'intro'
  | 'loading' | 'loadFailed' | 'recheck' | 'unsupported'
  | 'workbuddy' | 'copilot'
  | 'port' | 'listening' | 'listeningOn' | 'listeningOff'
  | 'app' | 'appRunning' | 'appStopped' | 'appMissing'
  | 'token' | 'tokenMissing' | 'tokenAge' | 'tokenFresh' | 'tokenStale'
  | 'ageJustNow' | 'ageMinutes' | 'ageHours' | 'ageDays' | 'ageMonths' | 'ageYears'
  | 'prerequisites' | 'prereqReady' | 'prereqMissing'
  | 'prereqMitmdump' | 'prereqHarvester' | 'prereqUpstreamProxy' | 'prereqCa'
  | 'guidanceMitmdump' | 'guidanceHarvester' | 'guidanceUpstreamProxy' | 'guidanceCa'
  | 'refresh' | 'refreshing' | 'refreshRunning' | 'refreshDone' | 'refreshFailed'
  | 'confirmTitle' | 'confirmBody' | 'confirm' | 'cancel' | 'close'
  | 'refusalUnsupportedPlatform' | 'refusalCopilotNotRunning' | 'refusalPrerequisitesMissing'
  | 'refusalBusy' | 'refusalScriptMissing' | 'refusalSpawnFailed'

/**
 * The page's translate seat: a dictionary key plus the shared `{name}`
 * template params, so an age phrase can carry its magnitude.
 */
export type LocalBridgeTranslate =
  (key: LocalBridgeLocaleKey, params?: Record<string, unknown>) => string

/** English copy. */
export const en: Record<LocalBridgeLocaleKey, string> = {
  nav: 'Local model services',
  title: 'Local model services',
  intro: 'The two model relays bundled with the desktop app, and the Copilot access token they run on.',
  loading: 'Checking this machine…',
  loadFailed: 'The local relay service did not answer. Restart the desktop app, then check again.',
  recheck: 'Check again',
  unsupported: 'These relays are available on Windows only.',
  workbuddy: 'WorkBuddy relay',
  copilot: 'Microsoft Copilot relay',
  port: 'Port',
  listening: 'Relay',
  listeningOn: 'Listening',
  listeningOff: 'Not listening',
  app: 'Desktop app',
  appRunning: 'Running',
  appStopped: 'Installed, not running',
  appMissing: 'Not found',
  token: 'Access token',
  tokenMissing: 'None yet',
  tokenAge: 'Obtained {age} ago',
  tokenFresh: 'Still valid',
  tokenStale: 'Expired; a refresh is due',
  ageJustNow: 'moments',
  ageMinutes: '{count} min',
  ageHours: '{count} h',
  ageDays: '{count} d',
  ageMonths: '{count} mo',
  ageYears: '{count} y',
  prerequisites: 'Refresh requirements',
  prereqReady: 'ready',
  prereqMissing: 'missing',
  prereqMitmdump: 'Interception proxy (mitmproxy)',
  prereqHarvester: 'Harvest script',
  prereqUpstreamProxy: 'Upstream proxy on 127.0.0.1:7890',
  prereqCa: 'Interception root certificate',
  guidanceMitmdump: 'Install it with pip install mitmproxy, then start the app again.',
  guidanceHarvester: 'Restart the app to deploy the harvest script, or copy bridge/token-harvester.py into the harvest directory by hand.',
  guidanceUpstreamProxy: 'Start your proxy client and leave its mixed port on 7890.',
  guidanceCa: 'Restart the app to import the certificate; Windows shows one security prompt you must accept.',
  refresh: 'Refresh token',
  refreshing: 'Refreshing…',
  refreshRunning: 'Refreshing. This usually takes one to two minutes, and the system proxy points at the local interception proxy meanwhile.',
  refreshDone: 'Refreshed. The relay keeps working for about another hour.',
  refreshFailed: 'The refresh produced no new token. Check the log, then try again.',
  confirmTitle: 'Refresh the Copilot token?',
  confirmBody: 'This changes the Windows system proxy for about a minute and drives the Copilot window to send one message. Leave Copilot running and avoid other network work until it finishes.',
  confirm: 'Start refresh',
  cancel: 'Cancel',
  close: 'Close',
  refusalUnsupportedPlatform: 'Refreshing is available on Windows only.',
  refusalCopilotNotRunning: 'Start the Copilot desktop app first.',
  refusalPrerequisitesMissing: 'A requirement above is unmet; the checklist names it.',
  refusalBusy: 'A refresh is already running. Wait for it to finish.',
  refusalScriptMissing: 'The refresh script is missing. Restart the app to redeploy it.',
  refusalSpawnFailed: 'The refresh process could not start. See the log for the reason.',
}

/** Simplified Chinese copy. */
export const zh: Record<LocalBridgeLocaleKey, string> = {
  nav: '本地模型服务',
  title: '本地模型服务',
  intro: '桌面端随包分发的两个模型中继，以及 Copilot 通道所依赖的访问令牌。',
  loading: '正在检测本机状态…',
  loadFailed: '本地中继服务没有响应。请重启桌面端后重试。',
  recheck: '重新检测',
  unsupported: '这两个中继只在 Windows 上可用。',
  workbuddy: 'WorkBuddy 中继',
  copilot: 'Microsoft Copilot 中继',
  port: '端口',
  listening: '中继状态',
  listeningOn: '监听中',
  listeningOff: '未监听',
  app: '后台应用',
  appRunning: '运行中',
  appStopped: '已安装但未运行',
  appMissing: '未检测到',
  token: '访问令牌',
  tokenMissing: '尚未获取',
  tokenAge: '获取于 {age}前',
  tokenFresh: '仍然有效',
  tokenStale: '已过期，该刷新了',
  ageJustNow: '片刻',
  ageMinutes: '{count} 分钟',
  ageHours: '{count} 小时',
  ageDays: '{count} 天',
  ageMonths: '{count} 个月',
  ageYears: '{count} 年',
  prerequisites: '刷新前置条件',
  prereqReady: '就绪',
  prereqMissing: '缺失',
  prereqMitmdump: '拦截代理（mitmproxy）',
  prereqHarvester: '收割脚本',
  prereqUpstreamProxy: '上游代理 127.0.0.1:7890',
  prereqCa: '拦截根证书',
  guidanceMitmdump: '先执行 pip install mitmproxy，然后重新启动应用。',
  guidanceHarvester: '重启应用会自动部署收割脚本；也可以手工把 bridge/token-harvester.py 复制到收割目录。',
  guidanceUpstreamProxy: '启动你的代理客户端，并保持它的混合端口为 7890。',
  guidanceCa: '重启应用即可导入证书；Windows 会弹一次安全确认，需要点「是」。',
  refresh: '刷新令牌',
  refreshing: '刷新中…',
  refreshRunning: '正在刷新，通常需要 1–2 分钟。期间系统代理会临时指向本地拦截代理。',
  refreshDone: '刷新完成，中继大约还能再用一小时。',
  refreshFailed: '这次刷新没有产生新令牌。看一下日志再重试。',
  confirmTitle: '刷新 Copilot 令牌？',
  confirmBody: '该操作会临时修改 Windows 系统代理约 1 分钟，并自动驱动 Copilot 窗口发送一条消息。期间请保持 Copilot 运行，也不要进行其他联网操作。',
  confirm: '开始刷新',
  cancel: '取消',
  close: '关闭',
  refusalUnsupportedPlatform: '刷新功能只在 Windows 上可用。',
  refusalCopilotNotRunning: '请先启动 Copilot 桌面端。',
  refusalPrerequisitesMissing: '上方有前置条件未满足，清单里已标出。',
  refusalBusy: '已有一次刷新在进行，请等它结束。',
  refusalScriptMissing: '找不到刷新脚本，重启应用即可重新部署。',
  refusalSpawnFailed: '刷新进程没能启动，日志里有原因。',
}
