/**
 * The desktop settings page reads `local-bridge/status` with the same
 * document-relative fetch Open-In uses. The browser attaches the session
 * cookie on its own. This boots the real web server, connection service, and
 * token authenticator — the desktop composition's control plane — and checks
 * that cookie is what admits the read, and that the body is one the page parser
 * accepts. The preflight module is replaced so the test does not launch
 * companion apps or touch the system proxy.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { parseStatusPayload } from '@deepseek-ai/dsh-client-ui-settings-local-bridge/src/client/controller.ts'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { BrowserAuth } from '@deepseek-ai/dsh-host-authentication-token/src/browser-auth.ts'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as LocalBridge from '../src/index.ts'
import { internals } from '../src/internals.ts'
import { LOCAL_BRIDGE_STATUS_PATH } from '../src/shared.ts'

it('serves a settings-page status snapshot to the desktop session cookie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-bridge-desktop-'))
  const ctx = new Context()
  onTestFinished(async () => {
    internals.preflight = undefined
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-local-bridge-desktop-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  internals.preflight = () => Promise.resolve({
    detectHarvest: () => Promise.resolve({
      hasToken: true, harvestedAt: '2026-10-14T03:51:50.000Z', ageSec: 30, stale: false, mitmdump: 'mitmdump',
    }),
    detectAllApps: () => Promise.resolve({
      workbuddy: { installed: true, running: false },
      copilot: { installed: true, running: true },
    }),
    detectCa: () => Promise.resolve({ installed: true }),
    refreshCopilotToken: () => Promise.resolve({ started: false }),
    REFRESH_LOCK_MS: 240_000,
    REFRESH_LOG_FILES: { transcript: 'auto-refresh.log', spawn: 'auto-refresh.spawn.log' },
  })
  const harvest = join(root, 'harvest')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    `- ${JSON.stringify({ name: 'cordis:credentials', config: { path: join(root, '.credentials.yaml'), watch: false } })}`,
    `- ${JSON.stringify({ name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } })}`,
    '- name: cordis:connection',
    '- name: cordis:token',
    `- ${JSON.stringify({
      name: 'cordis:local-bridge',
      config: {
        enabled: false,
        host: '127.0.0.1',
        port: 8787,
        backend: 'serve',
        cacheDir: '',
        copilot: { enabled: false, port: 8899, harvestDir: harvest },
        deps: { autoStart: false, autoRefreshToken: false, bootstrap: false, autoInstallCa: false, autoInstallMitm: false },
      },
    })}`,
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    credentials: LocalCredentials,
    webserver: WebServer,
    connection: Connection,
    token: Token,
    'local-bridge': LocalBridge,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const statusUrl = new URL(LOCAL_BRIDGE_STATUS_PATH, origin)

  const anonymous = await fetch(statusUrl, { headers: { accept: 'application/json' } })
  expect(anonymous.status).toBe(401)

  const auth = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  const exchanged = await fetch(auth.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
  expect(cookie).toBeDefined()
  const admitted = await fetch(statusUrl, {
    headers: { accept: 'application/json', cookie: cookie ?? '', 'sec-fetch-site': 'same-origin' },
  })
  expect(admitted.status).toBe(200)
  const parsed = parseStatusPayload(await admitted.json())
  expect(parsed).not.toBeNull()
  expect(parsed?.workbuddy.relay.port).toBe(8787)
  expect(parsed?.copilot.relay.port).toBe(8899)
  expect(parsed?.xiaoyi.relay.port).toBe(8123)
})
