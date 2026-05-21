export interface StatusResponse {
  env_saved: boolean
  ssh_key: boolean
  domain: boolean
  dns_provider: string
  dns_provider_configured: boolean
  proxmox: boolean
  deploy_running: boolean
  deploy_id?: number | null
}

export interface LoadEnvResponse {
  ok: boolean
  data?: Record<string, string>
  error?: string
}

export interface DetectSubnetResponse {
  ok: boolean
  subnets?: Array<{ cidr: string; ip: string }>
  error?: string
}

export interface PingCheckResponse {
  ok: boolean
  ip?: string
  free?: boolean
  in_use?: boolean
  error?: string
}

export interface PingProxmoxResponse {
  ok: boolean
  version?: string
  release?: string
  error?: string
}

export interface SaveEnvResponse {
  ok: boolean
  error?: string
}

export interface ValidateProxmoxResponse {
  ok: boolean
  nodes?: string
  error?: string
}

export interface NodeDatastore {
  name: string
  type: string
  free_gb: number
  total_gb: number
}

export interface NodeResources {
  cpu_cores: number
  mem_total_mb: number
  mem_free_mb: number
}

export interface DiscoverProxmoxResponse {
  ok: boolean
  node_name?: string
  all_nodes?: string[]
  datastores?: string[]
  datastores_by_node?: Record<string, NodeDatastore[]>
  node_resources_by_node?: Record<string, NodeResources>
  node_ips?: Record<string, string>
  pve_nodes_str?: string
  vmid_suggestions?: number[]
  node_memory_total_mb?: number
  node_memory_free_mb?: number
  node_disk_total_gb?: number
  node_disk_free_gb?: number
  error?: string
}

export interface SetupProxmoxUserResponse {
  ok: boolean
  token?: string
  user?: string
  error?: string
}

export interface SuggestVipItem {
  var: string
  name: string
  ip: string
  free: boolean
}

export interface SuggestVipsResponse {
  ok: boolean
  range?: string
  vips?: SuggestVipItem[]
  error?: string
}

export interface SuggestNodeIpsResponse {
  ok: boolean
  suggestions?: Array<{ ip: string; free: boolean }>
  error?: string
}

export interface GenerateSshKeyResponse {
  ok: boolean
  private_key?: string
  public_key?: string
  error?: string
}

export interface CheckDnsProviderResponse {
  ok: boolean
  status?: string
  error?: string
}

export interface CatalogItemResponse {
  ok: boolean
  items?: Array<Record<string, string>>
  error?: string
}

export interface GetKubeconfigResponse {
  ok: boolean
  kubeconfig?: string
  error?: string
}

export interface ValidateEnvIssue {
  field: string
  message: string
}

export interface ValidateEnvResponse {
  valid: boolean
  errors: ValidateEnvIssue[]
  warnings: ValidateEnvIssue[]
}

export interface CleanupInitResponse {
  ok: boolean
  vmId?: number | null
  error?: string
}

export type DeployEvent =
  | { type: 'log'; text: string; seq?: number; deploymentId?: number }
  | { type: 'progress'; pct: number; step: string; seq?: number; deploymentId?: number }
  | { type: 'done'; summary?: string; seq?: number; deploymentId?: number }
  | { type: 'error'; text: string; seq?: number; deploymentId?: number }

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  })

  const data = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with status ${response.status}`)
  }
  return data
}

async function streamEvents(input: string, init: RequestInit, onEvent: (event: DeployEvent) => void) {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
  })

  if (!response.ok || !response.body) {
    let errorText = 'Deploy API failed'
    try {
      const errorJson = (await response.json()) as { error?: string }
      errorText = errorJson.error ?? errorText
    } catch {
      // Ignore JSON parse failures for SSE responses.
    }
    throw new Error(errorText)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
      if (!dataLines.length) continue
      const raw = dataLines.join('\n').trim()
      if (!raw) continue
      try {
        onEvent(JSON.parse(raw) as DeployEvent)
      } catch {
        onEvent({ type: 'log', text: raw })
      }
    }
  }
}

export async function getStatus() {
  return fetchJson<StatusResponse>('/api/status', { method: 'GET', headers: {} })
}

export async function loadEnv() {
  return fetchJson<LoadEnvResponse>('/api/load-env', { method: 'GET', headers: {} })
}

export async function detectSubnet() {
  return fetchJson<DetectSubnetResponse>('/api/detect-subnet', { method: 'GET', headers: {} })
}

export async function pingCheck(ip: string) {
  return fetchJson<PingCheckResponse>(`/api/ping-check?ip=${encodeURIComponent(ip)}`, {
    method: 'GET',
    headers: {},
  })
}

export async function pingProxmox(host: string) {
  return fetchJson<PingProxmoxResponse>(`/api/ping-proxmox?host=${encodeURIComponent(host)}`, {
    method: 'GET',
    headers: {},
  })
}

export async function saveEnv(payload: Record<string, string>) {
  return fetchJson<SaveEnvResponse>('/api/save-env', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function setupProxmoxUser(host: string, username: string, password: string) {
  return fetchJson<SetupProxmoxUserResponse>('/api/setup-proxmox-user', {
    method: 'POST',
    body: JSON.stringify({ host, username, password }),
  })
}

export async function validateProxmox(payload: Record<string, string>) {
  return fetchJson<ValidateProxmoxResponse>('/api/validate-proxmox', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function discoverProxmox(host: string, token: string) {
  return fetchJson<DiscoverProxmoxResponse>('/api/discover-proxmox', {
    method: 'POST',
    body: JSON.stringify({ host, token }),
  })
}

export async function suggestVips(gateway: string, prefix: number) {
  return fetchJson<SuggestVipsResponse>('/api/suggest-vips', {
    method: 'POST',
    body: JSON.stringify({ gateway, prefix }),
  })
}

export async function suggestNodeIps(gateway: string, prefix: number) {
  return fetchJson<SuggestNodeIpsResponse>('/api/suggest-node-ips', {
    method: 'POST',
    body: JSON.stringify({ gateway, prefix }),
  })
}

export async function generateSshKey() {
  return fetchJson<GenerateSshKeyResponse>('/api/generate-ssh-key', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function checkDnsProvider(provider: string, credentials: Record<string, string>) {
  return fetchJson<CheckDnsProviderResponse>('/api/check-dns-provider', {
    method: 'POST',
    body: JSON.stringify({ provider, ...credentials }),
  })
}

export async function getCatalogItems() {
  return fetchJson<CatalogItemResponse>('/api/catalog-items', { method: 'GET', headers: {} })
}

export async function getKubeconfig() {
  return fetchJson<GetKubeconfigResponse>('/api/get-kubeconfig', { method: 'GET', headers: {} })
}

export async function validateEnv(env: Record<string, string>) {
  return fetchJson<ValidateEnvResponse>('/api/validate-env', {
    method: 'POST',
    body: JSON.stringify({ env }),
  })
}

export async function cleanupInit(stopServer = false) {
  return fetchJson<CleanupInitResponse>('/api/cleanup-init', {
    method: 'POST',
    body: JSON.stringify({ stopServer }),
  })
}

export async function connectDeployEvents(
  deploymentId: number | null,
  since: number,
  onEvent: (event: DeployEvent) => void,
) {
  const params = new URLSearchParams()
  if (deploymentId) params.set('deploymentId', String(deploymentId))
  if (since > 0) params.set('since', String(since))
  return streamEvents(`/api/deploy-events${params.size ? `?${params.toString()}` : ''}`, { method: 'GET' }, onEvent)
}

export async function deployStream(
  mode: 'deploy' | 'redeploy',
  onEvent: (event: DeployEvent) => void,
) {
  return streamEvents(mode === 'redeploy' ? '/api/redeploy' : '/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  }, onEvent)
}
