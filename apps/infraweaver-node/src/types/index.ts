export interface RegisterFrame {
  type: 'register'
  token: string
  publicKey: string
  clusterCaFingerprint: string
  ts: number
  sig?: string
}

export interface RegisteredFrame {
  type: 'registered'
  clusterId: string
  hubPublicKey: string
  ts: number
  sig?: string
}

export interface HeartbeatStatus {
  ready: boolean
  nodeCount: number
  podCount: number
}

export interface HeartbeatFrame {
  type: 'heartbeat'
  ts: number
  status: HeartbeatStatus
  sig?: string
}

export interface CommandFrame {
  type: 'command'
  requestId: string
  ts: number
  command: string
  params?: Record<string, unknown>
  sig?: string
}

export interface ResponseFrame {
  type: 'response'
  requestId: string
  ts: number
  status: number
  data: unknown
  sig?: string
}

export type SignedFrame = RegisterFrame | RegisteredFrame | HeartbeatFrame | CommandFrame | ResponseFrame

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`).join(',')}}`
}

export function getSignaturePayload(frame: SignedFrame): string {
  switch (frame.type) {
    case 'register':
      return [frame.type, frame.ts, frame.token, frame.publicKey, frame.clusterCaFingerprint].join(':')
    case 'registered':
      return [frame.type, frame.ts, frame.clusterId, frame.hubPublicKey].join(':')
    case 'heartbeat':
      return [frame.type, frame.ts, stableSerialize(frame.status)].join(':')
    case 'command':
      return [frame.type, frame.requestId, frame.ts, frame.command, stableSerialize(frame.params ?? null)].join(':')
    case 'response':
      return [frame.type, frame.requestId, frame.ts, frame.status, stableSerialize(frame.data ?? null)].join(':')
  }
}
