import { listNodes } from '../lib/k8s-client.js'

export async function handleGetNodes(params: Record<string, unknown> = {}): Promise<{ items: Array<Record<string, unknown>> }> {
  const name = typeof params.name === 'string' ? params.name : undefined
  const role = typeof params.role === 'string' ? params.role : undefined

  const items = (await listNodes()).filter((node) => {
    if (name && node.name !== name) {
      return false
    }

    if (role && (!Array.isArray(node.roles) || !node.roles.includes(role))) {
      return false
    }

    return true
  })

  return { items }
}
