import { describe, expect, it } from 'vitest'
import net from 'node:net'
import {
  describeSocketStack,
  formatProxyDiagnosis,
  parseProxyEndpoint,
  probeSystemProxy,
  probeTcp,
  readSystemProxy,
} from '../bridge/netdiag.mjs'

/**
 * 出站诊断。
 *
 * 这层存在的理由很具体：Copilot 通道装在 Electron 宿主里时，WebSocket 走 Chromium
 * 的网络栈，会自动读 Windows 系统代理。用户的代理客户端一旦没在工作（GUI 在、内核没起），
 * 通道立刻 502，而错误里只有一句「WebSocket 连接失败」—— 令牌过期、服务端限流、
 * 代理挂了共用这一句话，根本没法定位。
 *
 * 所以这里钉住的是「诊断必须说得出人话」，而不是具体的探测结果（后者依赖运行环境）。
 */

describe('parseProxyEndpoint', () => {
  it('reads a plain host:port proxy string', () => {
    expect(parseProxyEndpoint('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
  })

  it('takes the first endpoint out of a per-scheme proxy string', () => {
    expect(parseProxyEndpoint('127.0.0.1:8080;http=127.0.0.1:8081')).toEqual({ host: '127.0.0.1', port: 8080 })
  })

  it('returns null when there is no port to speak of', () => {
    expect(parseProxyEndpoint('')).toBeNull()
    expect(parseProxyEndpoint('proxy.example.com')).toBeNull()
  })
})

describe('describeSocketStack', () => {
  it('names the WebSocket implementation and lists the proxy env', () => {
    const stack = describeSocketStack()
    // 认得出是 Node 直连还是 Chromium（后者会读系统代理）。
    expect(['node-undici', 'chromium', 'unknown']).toContain(stack.impl)
    expect(typeof stack.proxyEnv).toBe('object')
  })
})

describe('readSystemProxy / probeSystemProxy', () => {
  it('reads the Windows proxy without throwing on other platforms', () => {
    const proxy = readSystemProxy()
    expect(typeof proxy.enabled).toBe('boolean')
    expect(typeof proxy.server).toBe('string')
  })

  it('reports reachability only when a proxy endpoint could be parsed', async () => {
    const proxy = await probeSystemProxy()
    // 只有「代理开着且地址能拆出来」时才会去探端口；否则 reachable 是 null。
    if (proxy.enabled && proxy.endpoint !== null) {
      expect(typeof proxy.reachable).toBe('boolean')
    } else {
      expect(proxy.reachable).toBeNull()
    }
  })
})

describe('probeTcp', () => {
  it('reports a closed port as unreachable', async () => {
    // 1 端口在正常机器上不会有人监听。
    expect(await probeTcp('127.0.0.1', 1, 800)).toBe(false)
  })

  it('reports an open port as reachable', async () => {
    const server = net.createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      // 超时给足：这条断言走的是真实 TCP 握手，机器正忙时 800ms 会偶发不够
      // （实测与并行的端到端探测一起跑时失败过一次）。
      expect(await probeTcp('127.0.0.1', port, 3000)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('formatProxyDiagnosis', () => {
  it('says the proxy port is not listening when it is not', () => {
    const text = formatProxyDiagnosis(
      { impl: 'chromium', proxyEnv: {} },
      {
        enabled: true,
        server: '127.0.0.1:7890',
        bypass: '',
        reachable: false,
        endpoint: { host: '127.0.0.1', port: 7890 },
      },
    )
    expect(text).toContain('127.0.0.1:7890')
    expect(text).toContain('无人监听')
  })

  it('mentions the Chromium implementation because it is the one that reads the system proxy', () => {
    const text = formatProxyDiagnosis(
      { impl: 'chromium', proxyEnv: {} },
      { enabled: true, server: '127.0.0.1:7890', bypass: '', reachable: true, endpoint: { host: '127.0.0.1', port: 7890 } },
    )
    expect(text).toContain('Chromium')
  })

  it('lists the proxy environment variables that are set', () => {
    const text = formatProxyDiagnosis(
      { impl: 'node-undici', proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890' } },
      { enabled: false, server: '', bypass: '', reachable: null, endpoint: null },
    )
    expect(text).toContain('HTTPS_PROXY')
    expect(text).toContain('Node')
  })

  it('says Node will use the proxy environment when NODE_USE_ENV_PROXY is on', () => {
    const text = formatProxyDiagnosis(
      {
        impl: 'node-undici',
        proxyEnv: { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      },
      { enabled: false, server: '', bypass: '', reachable: null, endpoint: null },
    )
    // 这是实测到的那个坑：启动环境里的代理变量会让 Node 的 WebSocket 也走代理。
    expect(text).toContain('NODE_USE_ENV_PROXY')
    expect(text).not.toContain('直连')
  })

  it('says nothing useful when there is no proxy at all', () => {
    const text = formatProxyDiagnosis(
      { impl: 'node-undici', proxyEnv: {} },
      { enabled: false, server: '', bypass: '', reachable: null, endpoint: null },
    )
    // 仍然要说清楚实现来源，否则「不读系统代理」这个关键事实会丢。
    expect(text).toContain('Node')
  })
})
