import type { CommandFrame, ResponseFrame } from '../types/index.js'

import { handleArgocd } from './argocd.js'
import { handleGetEvents } from './events.js'
import { handleGetMetrics } from './metrics.js'
import { handleGetNodes } from './nodes.js'
import { handleGetPods } from './pods.js'

const COMMAND_TIMEOUT_MS = 30_000

class CommandTimeoutError extends Error {
  constructor(command: string) {
    super(`Command timed out after 30 seconds: ${command}`)
    this.name = 'CommandTimeoutError'
  }
}

const HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  'get-nodes': handleGetNodes,
  'kubectl-get-nodes': handleGetNodes,
  'get-pods': handleGetPods,
  'kubectl-get-pods': handleGetPods,
  'argocd-list-apps': handleArgocd,
  'get-events': handleGetEvents,
  'kubectl-get-events': handleGetEvents,
  'get-metrics-nodes': handleGetMetrics,
  'kubectl-get-metrics-nodes': handleGetMetrics,
}

function withTimeout<T>(command: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandTimeoutError(command)), COMMAND_TIMEOUT_MS)

    promise
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

export async function dispatchCommand(frame: CommandFrame): Promise<ResponseFrame> {
  const handler = HANDLERS[frame.command]

  if (!handler) {
    return {
      type: 'response',
      requestId: frame.requestId,
      ts: Date.now(),
      status: 404,
      data: { error: `Unknown command: ${frame.command}` },
    }
  }

  try {
    const data = await withTimeout(frame.command, handler((frame.params ?? {}) as Record<string, unknown>))
    return {
      type: 'response',
      requestId: frame.requestId,
      ts: Date.now(),
      status: 200,
      data,
    }
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      return {
        type: 'response',
        requestId: frame.requestId,
        ts: Date.now(),
        status: 504,
        data: { error: error.message },
      }
    }

    return {
      type: 'response',
      requestId: frame.requestId,
      ts: Date.now(),
      status: 500,
      data: { error: (error as Error).message },
    }
  }
}
