import { listEvents } from '../lib/k8s-client.js'

export async function handleGetEvents(params: Record<string, unknown> = {}): Promise<{ items: Array<Record<string, unknown>> }> {
  const namespace = typeof params.namespace === 'string' ? params.namespace : undefined
  const name = typeof params.name === 'string' ? params.name : undefined
  const limit = typeof params.limit === 'number' ? params.limit : 100

  const items = (await listEvents(limit)).filter((event) => {
    if (namespace && event.namespace !== namespace) {
      return false
    }

    if (name && event.involvedObject && typeof event.involvedObject === 'object') {
      return (event.involvedObject as { name?: string }).name === name
    }

    return !name
  })

  return { items }
}
