import { createPrivateKey } from 'node:crypto'

import { dispatchCommand } from './commands/index.js'
import { importPublicKey } from './lib/crypto.js'
import { HubClient } from './lib/hub-client.js'
import { discover } from './lib/discover.js'
import { register } from './lib/registration.js'
import { loadState } from './lib/state.js'

const HUB_URL = process.env.HUB_URL ?? 'wss://api.int.rlservers.com'
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN

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

  client.connect()

  const shutdown = () => {
    client.disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[infraweaver-node] Fatal error', error)
  process.exit(1)
})
