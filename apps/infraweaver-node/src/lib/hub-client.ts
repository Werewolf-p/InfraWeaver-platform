import { EventEmitter } from 'node:events'
import type { KeyObject } from 'node:crypto'

import WebSocket from 'ws'

import { signFrame, verifyFrame } from './crypto.js'
import { getClusterStatus } from './k8s-client.js'
import { getSignaturePayload, type CommandFrame, type HeartbeatFrame, type SignedFrame } from '../types/index.js'

const HEARTBEAT_INTERVAL_MS = 30_000
const MAX_RECONNECT_DELAY_MS = 60_000

export class HubClient extends EventEmitter {
  private ws: WebSocket | null = null
  private reconnectDelay = 1_000
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private shouldReconnect = true

  constructor(
    private readonly url: string,
    private readonly clusterId: string,
    private readonly privateKey: KeyObject,
    private readonly hubPublicKey: KeyObject,
  ) {
    super()
  }

  connect(): void {
    this.shouldReconnect = true
    this.clearReconnectTimer()
    this.openConnection()
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.stopHeartbeat()

    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close()
    }

    this.ws = null
  }

  send(frame: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    const outgoingFrame = { ...(frame as Record<string, unknown>) } as SignedFrame

    if (typeof outgoingFrame.type !== 'string') {
      throw new Error('Cannot send frame without a type')
    }

    if (!outgoingFrame.ts) {
      outgoingFrame.ts = Date.now()
    }

    delete outgoingFrame.sig
    outgoingFrame.sig = signFrame(getSignaturePayload(outgoingFrame), this.privateKey)
    this.ws.send(JSON.stringify(outgoingFrame))
  }

  private openConnection(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.reconnectDelay = 1_000
      this.emit('connected', this.clusterId)
      this.startHeartbeat()
      void this.sendHeartbeat()
    })

    ws.on('message', (rawData) => {
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8')
      this.onMessage(text)
    })

    ws.on('close', () => {
      this.onClose()
    })

    ws.on('error', () => {
      // Errors are handled by the close event and reconnect logic.
    })
  }

  private onMessage(raw: string): void {
    let frame: Partial<SignedFrame> | null = null

    try {
      frame = JSON.parse(raw) as SignedFrame
    } catch {
      return
    }

    if (!frame || typeof frame !== 'object' || frame.type !== 'command' || !frame.sig) {
      return
    }

    const signature = frame.sig
    const unsignedFrame = { ...frame }
    delete unsignedFrame.sig

    if (!verifyFrame(getSignaturePayload(unsignedFrame as CommandFrame), signature, this.hubPublicKey)) {
      return
    }

    this.emit('command', frame as CommandFrame)
  }

  private onClose(): void {
    this.stopHeartbeat()
    this.ws = null
    this.emit('disconnected', this.clusterId)

    if (!this.shouldReconnect) {
      return
    }

    const jitter = Math.floor(Math.random() * 501)
    const delay = Math.min(this.reconnectDelay, MAX_RECONNECT_DELAY_MS) + jitter

    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.openConnection()
    }, delay)

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const status = await getClusterStatus().catch(() => ({ ready: false, nodeCount: 0, podCount: 0 }))

    const frame: HeartbeatFrame = {
      type: 'heartbeat',
      ts: Date.now(),
      status,
    }

    this.send(frame)
  }
}
