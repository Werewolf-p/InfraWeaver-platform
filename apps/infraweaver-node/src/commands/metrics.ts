import { listNodeMetrics } from '../lib/k8s-client.js'

export async function handleGetMetrics(params: Record<string, unknown> = {}): Promise<{ items: Array<Record<string, unknown>> }> {
  const name = typeof params.name === 'string' ? params.name : undefined

  const items = (await listNodeMetrics()).filter((metric) => {
    if (name && metric.name !== name) {
      return false
    }

    return true
  })

  return { items }
}
