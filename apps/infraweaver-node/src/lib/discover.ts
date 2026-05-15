import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import WebSocket from 'ws'

import { exportPrivateKey, exportPublicKey, generateKeyPair, importPublicKey } from './crypto.js'
import { saveState, type NodeState } from './state.js'

const DISCOVER_TIMEOUT_MS = 5 * 60 * 1000
const SERVICE_ACCOUNT_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

export interface DiscoverOptions {
  hubUrl: string
}

function normalizeWsUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl.startsWith('http') || rawUrl.startsWith('ws') ? rawUrl : `https://${rawUrl}`)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function getClusterCaFingerprint(): Promise<string> {
  try {
    const clusterCa = await readFile(SERVICE_ACCOUNT_CA_PATH)
    return createHash('sha256').update(clusterCa).digest('base64')
  } catch {
    return 'unknown'
  }
}

const AGENT_ID = randomUUID()

export async function discover({ hubUrl }: DiscoverOptions): Promise<NodeState> {
  const agentKeyPair = generateKeyPair()
  const clusterName = process.env.CLUSTER_NAME ?? hostname()
  const clusterCaFingerprint = await getClusterCaFingerprint()
  const discoverUrl = normalizeWsUrl(hubUrl, '/v1/ws/discover')

  console.log(`[discovery] Connecting to Hub at ${discoverUrl}`)
  console.log(`[discovery] Agent ID: ${AGENT_ID} — waiting for admin approval in console`)

  return await new Promise<NodeState>((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(discoverUrl, { rejectUnauthorized: false })

    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      callback()
    }

    const timeout = setTimeout(() => {
      finish(() => {
        ws.close()
        reject(new Error('Discovery timed out after 5 minutes — retry or set REGISTRATION_TOKEN'))
      })
    }, DISCOVER_TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        agentId: AGENT_ID,
        clusterName,
        publicKey: exportPublicKey(agentKeyPair),
        clusterCaFingerprint,
        ts: Date.now(),
      }))
      console.log('[discovery] Sent hello frame. Waiting for admin approval in the InfraWeaver console...')
    })

    ws.on('message', (rawData) => {
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8')

      let frame: {
        type?: string
        status?: string
        clusterId?: string
        hubPublicKey?: string
        reason?: string
      }

      try {
        frame = JSON.parse(text) as typeof frame
      } catch {
        return
      }

      if (frame.type === 'ack' && frame.status === 'pending_approval') {
        console.log('[discovery] Hub acknowledged — pending admin approval')
        return
      }

      if (frame.type === 'approved') {
        if (!frame.clusterId || !frame.hubPublicKey) {
          finish(() => {
            ws.close()
            reject(new Error('Discovery approval frame was missing required fields'))
          })
          return
        }

        try {
          importPublicKey(frame.hubPublicKey)
        } catch (error) {
          finish(() => {
            ws.close()
            reject(new Error(`Discovery approval contained an invalid hub key: ${(error as Error).message}`))
          })
          return
        }

        const state: NodeState = {
          clusterId: frame.clusterId,
          agentPrivateKeyPem: exportPrivateKey(agentKeyPair),
          hubPublicKeyBase64: frame.hubPublicKey,
          registeredAt: new Date().toISOString(),
        }

        void saveState(state)
          .then(() => {
            finish(() => {
              ws.close(1000, 'approved')
              resolve(state)
            })
          })
          .catch((error) => {
            finish(() => {
              ws.close()
              reject(error)
            })
          })
        return
      }

      if (frame.type === 'rejected') {
        finish(() => {
          ws.close(1000, 'rejected')
          reject(new Error(`Discovery rejected by admin: ${frame.reason ?? 'no reason given'}`))
        })
      }
    })

    ws.on('error', (error) => {
      finish(() => reject(new Error(`Discovery websocket error: ${error.message}`)))
    })

    ws.on('close', (code, reasonBuffer) => {
      if (settled) {
        return
      }

      const reason = reasonBuffer.toString('utf8')
      finish(() => {
        reject(
          new Error(
            reason
              ? `Discovery connection closed (${code}): ${reason}`
              : `Discovery connection closed (${code}) before approval`,
          ),
        )
      })
    })
  })
}
