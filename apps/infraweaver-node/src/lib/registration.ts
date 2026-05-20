import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import WebSocket from 'ws'

import { exportPrivateKey, exportPublicKey, generateKeyPair, importPublicKey, signFrame, verifyFrame } from './crypto.js'
import { saveState, type NodeState } from './state.js'
import { getSignaturePayload, type RegisteredFrame, type RegisterFrame } from '../types/index.js'

const REGISTRATION_TIMEOUT_MS = 30_000
const SERVICE_ACCOUNT_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

export interface RegisterOptions {
  hubUrl: string
  token: string
}

function normalizeWebSocketUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl)

  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }

  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function getClusterCaFingerprint(): Promise<string> {
  const clusterCa = await readFile(SERVICE_ACCOUNT_CA_PATH)
  return createHash('sha256').update(clusterCa).digest('base64')
}

export async function register({ hubUrl, token }: RegisterOptions): Promise<NodeState> {
  const agentKeyPair = generateKeyPair()
  const registerUrl = normalizeWebSocketUrl(hubUrl, '/v1/ws/register')
  const registerFrame: RegisterFrame = {
    type: 'register',
    token,
    publicKey: exportPublicKey(agentKeyPair),
    clusterCaFingerprint: await getClusterCaFingerprint(),
    ts: Date.now(),
  }
  registerFrame.sig = signFrame(getSignaturePayload(registerFrame), agentKeyPair.privateKey)

  return await new Promise<NodeState>((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(registerUrl)

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
        reject(new Error('Registration timed out after 30 seconds waiting for Hub response'))
      })
    }, REGISTRATION_TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(JSON.stringify(registerFrame))
    })

    ws.on('message', async (rawData) => {
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8')

      try {
        const frame = JSON.parse(text) as RegisteredFrame

        if (frame.type !== 'registered') {
          return
        }

        if (!frame.sig || !frame.clusterId || !frame.hubPublicKey || !frame.ts) {
          throw new Error('Hub registration response was missing required fields')
        }

        const hubPublicKey = importPublicKey(frame.hubPublicKey)
        if (!verifyFrame(getSignaturePayload(frame), frame.sig, hubPublicKey)) {
          throw new Error('Hub registration response signature validation failed')
        }

        const state: NodeState = {
          clusterId: frame.clusterId,
          agentPrivateKeyPem: exportPrivateKey(agentKeyPair),
          hubPublicKeyBase64: frame.hubPublicKey,
          registeredAt: new Date().toISOString(),
        }

        await saveState(state)

        finish(() => {
          ws.close()
          resolve(state)
        })
      } catch (error) {
        finish(() => {
          ws.close()
          reject(new Error(`Registration failed: ${(error as Error).message}`))
        })
      }
    })

    ws.on('error', (error) => {
      finish(() => reject(new Error(`Registration websocket error: ${error.message}`)))
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
              ? `Registration connection closed (${code}): ${reason}`
              : `Registration connection closed (${code}) before completion`,
          ),
        )
      })
    })
  })
}
