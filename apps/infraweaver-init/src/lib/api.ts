export interface StatusResponse {
  env_saved: boolean
  ssh_key: boolean
  domain: boolean
  dns_provider: string
  dns_provider_configured: boolean
  proxmox: boolean
  deploy_running: boolean
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

export interface DiscoverProxmoxResponse {
  ok: boolean
  node_name?: string
  all_nodes?: string[]
  datastores?: string[]
  datastores_by_node?: Record<string, string[]>
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

export type DeployEvent =
  | { type: 'log'; text: string }
  | { type: 'progress'; pct: number; step: string }
  | { type: 'done'; summary?: string }
  | { type: 'error'; text: string }

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

export async function deployStream(
  mode: 'deploy' | 'redeploy',
  onEvent: (event: DeployEvent) => void,
) {
  const response = await fetch(mode === 'redeploy' ? '/api/redeploy' : '/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
    cache: 'no-store',
  })

  if (!response.ok || !response.body) {
    throw new Error('Deploy API failed')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw) continue
      try {
        onEvent(JSON.parse(raw) as DeployEvent)
      } catch {
        onEvent({ type: 'log', text: raw })
      }
    }
  }
}
