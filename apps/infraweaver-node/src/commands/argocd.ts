const DEFAULT_ARGOCD_SERVER = 'http://argocd-server.argocd.svc.cluster.local'
const REQUEST_TIMEOUT_MS = 25_000

function normalizeServerUrl(rawUrl: string): string {
  return rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl
}

export async function handleArgocd(): Promise<{ items: Array<Record<string, unknown>> }> {
  const server = normalizeServerUrl(process.env.ARGOCD_SERVER ?? DEFAULT_ARGOCD_SERVER)
  const token = process.env.ARGOCD_TOKEN
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${server}/api/v1/applications`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`ArgoCD API request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as { items?: Array<any> }
    const items = Array.isArray(payload?.items) ? payload.items : []

    return {
      items: items.map((application) => ({
        name: application?.metadata?.name,
        namespace: application?.metadata?.namespace,
        project: application?.spec?.project,
        repoURL: application?.spec?.source?.repoURL,
        path: application?.spec?.source?.path,
        targetRevision: application?.spec?.source?.targetRevision,
        syncStatus: application?.status?.sync?.status,
        healthStatus: application?.status?.health?.status,
      })),
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('ArgoCD API request timed out')
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}
