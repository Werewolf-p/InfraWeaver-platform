import { createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'

import { dispatchCommand } from './commands/index.js'
import { importPublicKey } from './lib/crypto.js'
import { HubClient } from './lib/hub-client.js'
import { discover } from './lib/discover.js'
import { register } from './lib/registration.js'
import { loadState } from './lib/state.js'

const HUB_URL = process.env.HUB_URL ?? 'wss://api.int.rlservers.com'
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

async function main() {
  console.log('[infraweaver-node] Starting...')

  let state = await loadState()

  if (!state) {
    if (REGISTRATION_TOKEN) {
      console.log('[infraweaver-node] No state found. Starting token registration...')
      state = await register({ hubUrl: HUB_URL, token: REGISTRATION_TOKEN })
      console.log(`[infraweaver-node] Registered as cluster: ${state.clusterId}`)
    } else {
      console.log('[infraweaver-node] No token set — entering discovery mode. Waiting for admin approval...')
      state = await discover({ hubUrl: HUB_URL })
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

  client.on('connected', () => console.log('[infraweaver-node] Connected to Hub'))
  client.on('disconnected', () => console.log('[infraweaver-node] Disconnected from Hub, reconnecting...'))

  let shuttingDown = false
  const healthServer = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '/'
    const connected = client.isConnected()

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', connected }))
      return
    }

    if (path === '/ready') {
      const ready = connected && !shuttingDown
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready', connected }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
  })

  await new Promise<void>((resolve) => {
    healthServer.listen(HEALTH_PORT, resolve)
  })
  console.log(`[infraweaver-node] Health server listening on :${HEALTH_PORT}`)

  client.connect()

  const shutdown = () => {
    shuttingDown = true
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
