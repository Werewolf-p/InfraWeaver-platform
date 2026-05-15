import { listPods } from '../lib/k8s-client.js'

export async function handleGetPods(params: Record<string, unknown> = {}): Promise<{ items: Array<Record<string, unknown>> }> {
  const namespace = typeof params.namespace === 'string' ? params.namespace : undefined
  const name = typeof params.name === 'string' ? params.name : undefined
  const nodeName = typeof params.nodeName === 'string' ? params.nodeName : undefined
  const limit = typeof params.limit === 'number' ? params.limit : undefined

  let items = (await listPods()).filter((pod) => {
    if (namespace && pod.namespace !== namespace) {
      return false
    }

    if (name && pod.name !== name) {
      return false
    }

    if (nodeName && pod.nodeName !== nodeName) {
      return false
    }

    return true
  })

  if (typeof limit === 'number' && limit >= 0) {
    items = items.slice(0, limit)
  }

  return { items }
}
