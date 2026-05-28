import { createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'

import { dispatchCommand } from './commands/index.js'
import { importPublicKey } from './lib/crypto.js'
import { HubClient } from './lib/hub-client.js'
import { discover } from './lib/discover.js'
import { register } from './lib/registration.js'
import { loadState } from './lib/state.js'

const HUB_URL = process.env.HUB_URL ?? 'wss://api.int.yourdomain.com'
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN
const HEALTH_PORT = Number.parseInt(process.env.PORT ?? '3001', 10)

function buildClusterWebSocketUrl(hubUrl: string, clusterId: string): string {
  const url = new URL(hubUrl)

  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }

  url.pathname = `/v1/ws/cluster/${clusterId}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 12,
  baseDelayMs = 5000,
  isRetryable?: (error: Error) => boolean,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const msg = (error as Error).message ?? ''
      const code = (error as NodeJS.ErrnoException).code
      const defaultRetryable =
        code === 'EAI_AGAIN' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        msg.includes('getaddrinfo') ||
        msg.includes('ECONNREFUSED')
      const shouldRetry = isRetryable ? isRetryable(error as Error) : defaultRetryable
      if (attempt < maxAttempts && shouldRetry) {
        const delay = Math.min(baseDelayMs * attempt, 60000)
        console.log(`[infraweaver-node] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${msg}`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        throw error
      }
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`)
}

// Discovery errors that should trigger a retry (timeout, connectivity) vs hard stop (rejected by admin)
function isDiscoveryRetryable(error: Error): boolean {
  const msg = error.message ?? ''
  const code = (error as NodeJS.ErrnoException).code
  if (msg.includes('rejected by admin')) return false
  return (
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    msg.includes('timed out') ||
    msg.includes('closed') ||
    msg.includes('websocket') ||
    msg.includes('getaddrinfo') ||
    msg.includes('ECONNREFUSED')
  )
}

async function main() {
  console.log('[infraweaver-node] Starting...')

  // Start health server immediately so the liveness probe never kills us while
  // waiting for admin approval in discovery mode (which can take minutes).
  const appState = { connected: false, shuttingDown: false }

  const healthServer = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '/'

    if (path === '/health') {
      // Always 200 — the process is alive even before approval
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', connected: appState.connected }))
      return
    }

    if (path === '/ready') {
      const ready = appState.connected && !appState.shuttingDown
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready', connected: appState.connected }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
  })

  await new Promise<void>((resolve) => {
    healthServer.listen(HEALTH_PORT, resolve)
  })
  console.log(`[infraweaver-node] Health server listening on :${HEALTH_PORT}`)

  let state = await loadState()

  if (!state) {
    if (REGISTRATION_TOKEN) {
      console.log('[infraweaver-node] No state found. Starting token registration...')
      state = await withRetry(() => register({ hubUrl: HUB_URL, token: REGISTRATION_TOKEN! }), 'registration')
      console.log(`[infraweaver-node] Registered as cluster: ${state.clusterId}`)
    } else {
      console.log('[infraweaver-node] No token set — entering discovery mode. Waiting for admin approval...')
      // Retry indefinitely on timeout/connectivity errors; stop only if explicitly rejected
      state = await withRetry(
        () => discover({ hubUrl: HUB_URL }),
        'discovery',
        Number.MAX_SAFE_INTEGER,
        5000,
        isDiscoveryRetryable,
      )
      console.log(`[infraweaver-node] Approved as cluster: ${state.clusterId}`)
    }
  }

  const privateKey = createPrivateKey({ key: state.agentPrivateKeyPem, format: 'pem' })
  const hubPublicKey = importPublicKey(state.hubPublicKeyBase64)

  const client = new HubClient(
    buildClusterWebSocketUrl(HUB_URL, state.clusterId),
    state.clusterId,
    privateKey,
    hubPublicKey,
  )

  client.on('command', async (frame) => {
    const response = await dispatchCommand(frame)
    client.send(response)
  })

  client.on('connected', () => {
    appState.connected = true
    console.log('[infraweaver-node] Connected to Hub')
  })
  client.on('disconnected', () => {
    appState.connected = false
    console.log('[infraweaver-node] Disconnected from Hub, reconnecting...')
  })

  client.connect()

  const shutdown = () => {
    appState.shuttingDown = true
    client.disconnect()
    healthServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5_000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[infraweaver-node] Fatal error', error)
  process.exit(1)
})
