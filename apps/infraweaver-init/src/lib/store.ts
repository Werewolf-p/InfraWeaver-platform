import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  CheckDnsProviderResponse,
  DiscoverProxmoxResponse,
  StatusResponse,
  ValidateProxmoxResponse,
} from '@/lib/api'
import { deriveAdminName, parseBoolean, sanitizeUsername } from '@/lib/utils'

export type BackupProvider = 'none' | 'longhorn' | 'velero' | 'both'
export type DnsProvider = 'cloudflare' | 'route53' | 'azure' | 'digitalocean' | 'hetzner' | 'none'
export type PingState = boolean | null | 'loading'
export type DeployLogLevel = 'info' | 'step' | 'ok' | 'warn' | 'err'
export type PresetType = 'dev' | 'standard' | 'power'

export interface NodeConfig {
  id: string
  ip: string
  vmid: string
  pveNode: string
  datastore: string
  cpu: string
  memory: string
  disk: string
  role: 'control-plane' | 'worker'
}

export interface DeployStage {
  name: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: number
  completedAt?: number
}

export interface DeployLogLine {
  id: string
  text: string
  level: DeployLogLevel
}

export interface WizardData {
  BASE_DOMAIN: string
  ADMIN_EMAIL: string
  PROXMOX_HOST: string
  PROXMOX_API_TOKEN: string
  PROXMOX_NODE_NAME: string
  K8S_CLUSTER_NAME: string
  NODE_GATEWAY: string
  NODE_SUBNET_PREFIX: string
  TALOS_DATASTORE: string
  METALLB_VIP_RANGE: string
  METALLB_TRAEFIK_VIP: string
  METALLB_COREDNS_VIP: string
  METALLB_NETBIRD_MGMT_VIP: string
  METALLB_NETBIRD_SIGNAL_VIP: string
  METALLB_NETBIRD_RELAY_VIP: string
  CLUSTER_LOCAL_DOMAIN: string
  ADMIN_USERNAME: string
  ADMIN_NAME: string
  DEPLOYER_SSH_KEY: string
  DNS_PROVIDER: DnsProvider
  CLOUDFLARE_API_TOKEN: string
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  AWS_HOSTED_ZONE_ID: string
  AWS_REGION: string
  AZURE_CLIENT_ID: string
  AZURE_CLIENT_SECRET: string
  AZURE_SUBSCRIPTION_ID: string
  AZURE_TENANT_ID: string
  AZURE_RESOURCE_GROUP: string
  DIGITALOCEAN_TOKEN: string
  HETZNER_DNS_API_KEY: string
  SMTP_USERNAME: string
  SMTP_PASSWORD: string
  SMTP_TO: string
  NETBIRD_API_TOKEN: string
  GITHUB_REPO: string
  GIT_REPO_URL: string
  GITHUB_PAT: string
  RUNNER_REGISTRATION_TOKEN: string
  ENV_NAME: string
  LETSENCRYPT_ENV: string
  ENABLE_NETBIRD: boolean
  ENABLE_MONITORING: boolean
  ENABLE_EXTERNAL_DNS: boolean
  BACKUP_PROVIDER: BackupProvider
}

const vipPingFields = [
  'METALLB_TRAEFIK_VIP',
  'METALLB_COREDNS_VIP',
  'METALLB_NETBIRD_MGMT_VIP',
  'METALLB_NETBIRD_SIGNAL_VIP',
  'METALLB_NETBIRD_RELAY_VIP',
] as const

type VipPingField = (typeof vipPingFields)[number]

type LegacyNodeField =
  | 'NODE_1_IP'
  | 'NODE_1_VMID'
  | 'NODE_2_IP'
  | 'NODE_2_VMID'
  | 'NODE_3_IP'
  | 'NODE_3_VMID'
  | 'PVE_NODES'
  | 'NODE_1_PVE_NODE'
  | 'NODE_1_DATASTORE'
  | 'NODE_1_CPU'
  | 'NODE_1_MEMORY'
  | 'NODE_1_DISK'
  | 'NODE_2_PVE_NODE'
  | 'NODE_2_DATASTORE'
  | 'NODE_2_CPU'
  | 'NODE_2_MEMORY'
  | 'NODE_2_DISK'
  | 'NODE_3_PVE_NODE'
  | 'NODE_3_DATASTORE'
  | 'NODE_3_CPU'
  | 'NODE_3_MEMORY'
  | 'NODE_3_DISK'

const legacyNodeFields: LegacyNodeField[] = [
  'NODE_1_IP',
  'NODE_1_VMID',
  'NODE_2_IP',
  'NODE_2_VMID',
  'NODE_3_IP',
  'NODE_3_VMID',
  'PVE_NODES',
  'NODE_1_PVE_NODE',
  'NODE_1_DATASTORE',
  'NODE_1_CPU',
  'NODE_1_MEMORY',
  'NODE_1_DISK',
  'NODE_2_PVE_NODE',
  'NODE_2_DATASTORE',
  'NODE_2_CPU',
  'NODE_2_MEMORY',
  'NODE_2_DISK',
  'NODE_3_PVE_NODE',
  'NODE_3_DATASTORE',
  'NODE_3_CPU',
  'NODE_3_MEMORY',
  'NODE_3_DISK',
]

export const initialWizardData: WizardData = {
  BASE_DOMAIN: '',
  ADMIN_EMAIL: '',
  PROXMOX_HOST: '192.168.1.100',
  PROXMOX_API_TOKEN: '',
  PROXMOX_NODE_NAME: 'pve',
  K8S_CLUSTER_NAME: 'infraweaver-prod',
  NODE_GATEWAY: '10.10.0.1',
  NODE_SUBNET_PREFIX: '24',
  TALOS_DATASTORE: 'lvm-proxmox',
  METALLB_VIP_RANGE: '10.10.0.200-10.10.0.210',
  METALLB_TRAEFIK_VIP: '10.10.0.200',
  METALLB_COREDNS_VIP: '10.10.0.201',
  METALLB_NETBIRD_MGMT_VIP: '10.10.0.202',
  METALLB_NETBIRD_SIGNAL_VIP: '10.10.0.203',
  METALLB_NETBIRD_RELAY_VIP: '10.10.0.204',
  CLUSTER_LOCAL_DOMAIN: 'prod.local',
  ADMIN_USERNAME: '',
  ADMIN_NAME: '',
  DEPLOYER_SSH_KEY: '',
  DNS_PROVIDER: 'cloudflare',
  CLOUDFLARE_API_TOKEN: '',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_HOSTED_ZONE_ID: '',
  AWS_REGION: 'us-east-1',
  AZURE_CLIENT_ID: '',
  AZURE_CLIENT_SECRET: '',
  AZURE_SUBSCRIPTION_ID: '',
  AZURE_TENANT_ID: '',
  AZURE_RESOURCE_GROUP: '',
  DIGITALOCEAN_TOKEN: '',
  HETZNER_DNS_API_KEY: '',
  SMTP_USERNAME: '',
  SMTP_PASSWORD: '',
  SMTP_TO: '',
  NETBIRD_API_TOKEN: '',
  GITHUB_REPO: 'Werewolf-p/InfraWeaver-platform',
  GIT_REPO_URL: 'https://github.com/Werewolf-p/InfraWeaver-platform',
  GITHUB_PAT: '',
  RUNNER_REGISTRATION_TOKEN: '',
  ENV_NAME: 'productie',
  LETSENCRYPT_ENV: 'production',
  ENABLE_NETBIRD: true,
  ENABLE_MONITORING: true,
  ENABLE_EXTERNAL_DNS: false,
  BACKUP_PROVIDER: 'longhorn',
}

export const initialNodes: NodeConfig[] = [
  { id: 'node-1', ip: '10.10.0.90', vmid: '9310', pveNode: '', datastore: '', cpu: '4', memory: '8192', disk: '100', role: 'control-plane' },
  { id: 'node-2', ip: '10.10.0.91', vmid: '9311', pveNode: '', datastore: '', cpu: '4', memory: '8192', disk: '100', role: 'control-plane' },
  { id: 'node-3', ip: '10.10.0.92', vmid: '9312', pveNode: '', datastore: '', cpu: '4', memory: '8192', disk: '100', role: 'control-plane' },
]

export const initialDeployStages: DeployStage[] = [
  { name: 'generate', label: 'Generate config', status: 'pending' },
  { name: 'opentofu', label: 'OpenTofu (VMs)', status: 'pending' },
  { name: 'bootstrap', label: 'Secrets & ESO', status: 'pending' },
  { name: 'argocd', label: 'ArgoCD sync', status: 'pending' },
  { name: 'apps', label: 'Apps & ingress', status: 'pending' },
  { name: 'postdeploy', label: 'Post-deploy', status: 'pending' },
]

const emptyVipPing: Record<VipPingField, PingState> = {
  METALLB_TRAEFIK_VIP: null,
  METALLB_COREDNS_VIP: null,
  METALLB_NETBIRD_MGMT_VIP: null,
  METALLB_NETBIRD_SIGNAL_VIP: null,
  METALLB_NETBIRD_RELAY_VIP: null,
}

const emptyLoadingState = {
  discoverProxmox: false,
  validateProxmox: false,
  setupProxmoxUser: false,
  suggestNodeIps: false,
  suggestVips: false,
  generateSshKey: false,
  checkDnsProvider: false,
  detectSubnets: false,
  saveEnv: false,
  deploy: false,
}

interface PersistedWizardState {
  currentStep?: number
  data?: Record<string, unknown>
  localIpRanges?: string[]
  vpnOnly?: boolean
  generatedPublicKey?: string
  nodes?: NodeConfig[]
  preset?: PresetType | null
  deployStarted?: boolean
  deployId?: number | null
  deployLastEventSeq?: number
  deployLogs?: DeployLogLine[]
  deployProgress?: number
  deployStepText?: string
  deployRunning?: boolean
  deploySummary?: string
  deployError?: string
  deployStages?: DeployStage[]
}

interface WizardStore {
  currentStep: number
  data: WizardData
  nodes: NodeConfig[]
  preset: PresetType | null
  localIpRanges: string[]
  vpnOnly: boolean
  status: StatusResponse | null
  nodePing: Record<string, PingState>
  vipPing: Record<VipPingField, PingState>
  loading: typeof emptyLoadingState
  proxmoxDiscovery: DiscoverProxmoxResponse | null
  proxmoxValidation: ValidateProxmoxResponse | null
  dnsProviderCheck: CheckDnsProviderResponse | null
  detectedSubnets: Array<{ cidr: string; ip: string }>
  generatedPublicKey: string
  deployLogs: DeployLogLine[]
  deployProgress: number
  deployStepText: string
  deployRunning: boolean
  deployStarted: boolean
  deployId: number | null
  deployLastEventSeq: number
  deploySummary: string
  deployError: string
  deployStages: DeployStage[]
  setCurrentStep: (step: number) => void
  setField: <K extends keyof WizardData>(key: K, value: WizardData[K]) => void
  setFields: (fields: Partial<WizardData>) => void
  addNode: () => void
  removeNode: (id: string) => void
  updateNode: (id: string, fields: Partial<NodeConfig>) => void
  setPreset: (preset: PresetType) => void
  autofillIdentityFromEmail: () => void
  autofillRepoUrl: () => void
  setStatus: (status: StatusResponse | null) => void
  setLoading: (key: keyof typeof emptyLoadingState, value: boolean) => void
  setNodePing: (id: string, value: PingState) => void
  setVipPing: (field: VipPingField, value: PingState) => void
  setProxmoxDiscovery: (value: DiscoverProxmoxResponse | null) => void
  setProxmoxValidation: (value: ValidateProxmoxResponse | null) => void
  setDnsProviderCheck: (value: CheckDnsProviderResponse | null) => void
  setGeneratedPublicKey: (value: string) => void
  addLocalIpRange: () => void
  updateLocalIpRange: (index: number, value: string) => void
  removeLocalIpRange: (index: number) => void
  setVpnOnly: (value: boolean) => void
  mergeDetectedSubnets: (subnets: Array<{ cidr: string; ip: string }>) => number
  loadFromEnv: (payload: Record<string, string>) => void
  getEnvPayload: () => Record<string, string>
  resetDeploy: () => void
  appendDeployLog: (text: string, level?: DeployLogLevel) => void
  setDeployState: (state: Partial<Pick<WizardStore, 'deployProgress' | 'deployStepText' | 'deployRunning' | 'deployStarted' | 'deployId' | 'deployLastEventSeq' | 'deploySummary' | 'deployError'>>) => void
  setDeployStages: (stages: DeployStage[]) => void
  updateDeployStage: (name: string, update: Partial<DeployStage>) => void
  transitionDeployStage: (name: string) => void
  finalizeDeployStages: (status: 'done' | 'failed') => void
}

const cloneDeployStages = (stages: DeployStage[]) => stages.map((stage) => ({ ...stage }))

const buildNodePing = (nodes: NodeConfig[]) =>
  Object.fromEntries(nodes.map((node) => [node.id, null])) as Record<string, PingState>

const sanitizeWizardData = (input?: Record<string, unknown> | null): WizardData => {
  const next: WizardData = { ...initialWizardData }
  if (!input) return next
  for (const [key, value] of Object.entries(input)) {
    if (legacyNodeFields.includes(key as LegacyNodeField)) continue
    if (key in next) {
      ;(next as unknown as Record<string, unknown>)[key] = value
    }
  }
  return next
}

const normalizeNode = (node: Partial<NodeConfig>, index: number): NodeConfig => ({
  id: typeof node.id === 'string' && node.id.trim() ? node.id : `node-${index + 1}`,
  ip: typeof node.ip === 'string' ? node.ip : initialNodes[Math.min(index, initialNodes.length - 1)]?.ip ?? '',
  vmid: typeof node.vmid === 'string' ? node.vmid : String(9310 + index),
  pveNode: typeof node.pveNode === 'string' ? node.pveNode : '',
  datastore: typeof node.datastore === 'string' ? node.datastore : '',
  cpu: typeof node.cpu === 'string' && node.cpu ? node.cpu : index >= 3 ? '2' : '4',
  memory: typeof node.memory === 'string' && node.memory ? node.memory : index >= 3 ? '4096' : '8192',
  disk: typeof node.disk === 'string' && node.disk ? node.disk : index >= 3 ? '80' : '100',
  role: node.role === 'worker' ? 'worker' : 'control-plane',
})

const isNodeConfigArray = (value: unknown): value is NodeConfig[] =>
  Array.isArray(value) && value.every((item) => item && typeof item === 'object')

const extractLegacyNodes = (data?: Record<string, unknown> | null): NodeConfig[] => {
  if (!data || !legacyNodeFields.some((field) => field in data)) return initialNodes.map((node) => ({ ...node }))

  const nodes: NodeConfig[] = []
  for (let index = 1; index <= 3; index += 1) {
    const ip = typeof data[`NODE_${index}_IP`] === 'string' ? (data[`NODE_${index}_IP`] as string) : ''
    const vmid = typeof data[`NODE_${index}_VMID`] === 'string' ? (data[`NODE_${index}_VMID`] as string) : String(9309 + index)
    const pveNode = typeof data[`NODE_${index}_PVE_NODE`] === 'string' ? (data[`NODE_${index}_PVE_NODE`] as string) : ''
    const datastore = typeof data[`NODE_${index}_DATASTORE`] === 'string' ? (data[`NODE_${index}_DATASTORE`] as string) : ''
    const cpu = typeof data[`NODE_${index}_CPU`] === 'string' ? (data[`NODE_${index}_CPU`] as string) : '4'
    const memory = typeof data[`NODE_${index}_MEMORY`] === 'string' ? (data[`NODE_${index}_MEMORY`] as string) : '8192'
    const disk = typeof data[`NODE_${index}_DISK`] === 'string' ? (data[`NODE_${index}_DISK`] as string) : '100'
    if ([ip, vmid, pveNode, datastore, cpu, memory, disk].some((value) => value !== '')) {
      nodes.push(
        normalizeNode(
          {
            id: `node-${index}`,
            ip,
            vmid,
            pveNode,
            datastore,
            cpu,
            memory,
            disk,
            role: 'control-plane',
          },
          index - 1,
        ),
      )
    }
  }

  return nodes.length ? nodes : initialNodes.map((node) => ({ ...node }))
}

const getHighestNodeOrdinal = (nodes: NodeConfig[]) =>
  nodes.reduce((max, node) => {
    const match = node.id.match(/node-(\d+)/)
    const value = match ? Number.parseInt(match[1], 10) : 0
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0)

const createNodeFromTemplate = (
  ordinal: number,
  template: Pick<NodeConfig, 'cpu' | 'memory' | 'disk' | 'role'>,
  basePveNode: string,
  baseDatastore: string,
): NodeConfig => ({
  id: `node-${ordinal}`,
  ip: `10.10.0.${89 + ordinal}`,
  vmid: String(9309 + ordinal),
  pveNode: basePveNode,
  datastore: baseDatastore,
  cpu: template.cpu,
  memory: template.memory,
  disk: template.disk,
  role: template.role,
})

const buildPresetNodes = (preset: PresetType, data: WizardData, currentNodes: NodeConfig[]) => {
  const basePveNode = currentNodes[0]?.pveNode || data.PROXMOX_NODE_NAME || ''
  const baseDatastore = currentNodes[0]?.datastore || data.TALOS_DATASTORE || ''

  if (preset === 'dev') {
    return [createNodeFromTemplate(1, { cpu: '2', memory: '4096', disk: '50', role: 'control-plane' }, basePveNode, baseDatastore)]
  }

  if (preset === 'power') {
    return [
      createNodeFromTemplate(1, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
      createNodeFromTemplate(2, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
      createNodeFromTemplate(3, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
      createNodeFromTemplate(4, { cpu: '2', memory: '4096', disk: '80', role: 'worker' }, basePveNode, baseDatastore),
      createNodeFromTemplate(5, { cpu: '2', memory: '4096', disk: '80', role: 'worker' }, basePveNode, baseDatastore),
    ]
  }

  return [
    createNodeFromTemplate(1, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
    createNodeFromTemplate(2, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
    createNodeFromTemplate(3, { cpu: '4', memory: '8192', disk: '100', role: 'control-plane' }, basePveNode, baseDatastore),
  ]
}

const buildPresetFields = (preset: PresetType): Partial<WizardData> => {
  if (preset === 'dev') {
    return {
      ENABLE_MONITORING: false,
      ENABLE_NETBIRD: false,
      ENABLE_EXTERNAL_DNS: false,
      BACKUP_PROVIDER: 'none',
    }
  }

  if (preset === 'power') {
    return {
      ENABLE_MONITORING: true,
      ENABLE_NETBIRD: true,
      ENABLE_EXTERNAL_DNS: true,
      BACKUP_PROVIDER: 'both',
    }
  }

  return {
    ENABLE_MONITORING: true,
    ENABLE_NETBIRD: true,
    ENABLE_EXTERNAL_DNS: false,
    BACKUP_PROVIDER: 'longhorn',
  }
}

const createNextNode = (nodes: NodeConfig[], data: WizardData): NodeConfig => {
  const lastNode = nodes[nodes.length - 1]
  const lastIp = lastNode?.ip ?? '10.10.0.90'
  const nextIp = /\d+$/.test(lastIp) ? lastIp.replace(/\d+$/, (match) => String(Number.parseInt(match, 10) + 1)) : '10.10.0.90'
  const lastVmid = Number.parseInt(lastNode?.vmid ?? '9310', 10)
  const nextVmid = String((Number.isFinite(lastVmid) ? lastVmid : 9310) + 1)
  const nextOrdinal = getHighestNodeOrdinal(nodes) + 1
  const workerDefaults = nodes.length >= 3
  return normalizeNode(
    {
      id: `node-${nextOrdinal}`,
      ip: nextIp,
      vmid: nextVmid,
      pveNode: nodes[0]?.pveNode || data.PROXMOX_NODE_NAME || '',
      datastore: nodes[0]?.datastore || data.TALOS_DATASTORE || '',
      cpu: workerDefaults ? '2' : '4',
      memory: workerDefaults ? '4096' : '8192',
      disk: workerDefaults ? '80' : '100',
      role: workerDefaults ? 'worker' : 'control-plane',
    },
    nodes.length,
  )
}

export function isWizardDataPristine(data: WizardData) {
  return !data.BASE_DOMAIN && !data.PROXMOX_API_TOKEN && !data.DEPLOYER_SSH_KEY && !data.CLOUDFLARE_API_TOKEN && !data.SMTP_USERNAME && data.DNS_PROVIDER === 'cloudflare'
}

export const useWizardStore = create<WizardStore>()(
  persist(
    (set, get) => ({
      currentStep: 0,
      data: initialWizardData,
      nodes: initialNodes.map((node) => ({ ...node })),
      preset: 'standard',
      localIpRanges: [''],
      vpnOnly: false,
      status: null,
      nodePing: buildNodePing(initialNodes),
      vipPing: emptyVipPing,
      loading: emptyLoadingState,
      proxmoxDiscovery: null,
      proxmoxValidation: null,
      dnsProviderCheck: null,
      detectedSubnets: [],
      generatedPublicKey: '',
      deployLogs: [],
      deployProgress: 0,
      deployStepText: 'Waiting to deploy…',
      deployRunning: false,
      deployStarted: false,
      deployId: null,
      deployLastEventSeq: 0,
      deploySummary: '',
      deployError: '',
      deployStages: cloneDeployStages(initialDeployStages),
      setCurrentStep: (step) => set({ currentStep: step }),
      setField: (key, value) =>
        set((state) => ({
          data: {
            ...state.data,
            [key]: value,
          },
        })),
      setFields: (fields) => set((state) => ({ data: { ...state.data, ...fields } })),
      addNode: () =>
        set((state) => {
          if (state.nodes.length >= 6) return state
          const newNode = createNextNode(state.nodes, state.data)
          return {
            nodes: [...state.nodes, newNode],
            nodePing: { ...state.nodePing, [newNode.id]: null },
          }
        }),
      removeNode: (id) =>
        set((state) => {
          if (state.nodes.length <= 1) return state
          const target = state.nodes.find((node) => node.id === id)
          if (!target) return state
          const controlPlaneCount = state.nodes.filter((node) => node.role === 'control-plane').length
          if (target.role === 'control-plane' && controlPlaneCount <= 1) return state
          const nextNodes = state.nodes.filter((node) => node.id !== id)
          const nextPing = { ...state.nodePing }
          delete nextPing[id]
          return { nodes: nextNodes, nodePing: nextPing }
        }),
      updateNode: (id, fields) =>
        set((state) => ({
          nodes: state.nodes.map((node, index) => (node.id === id ? normalizeNode({ ...node, ...fields }, index) : node)),
        })),
      setPreset: (preset) =>
        set((state) => {
          const nextNodes = buildPresetNodes(preset, state.data, state.nodes)
          return {
            preset,
            data: { ...state.data, ...buildPresetFields(preset) },
            nodes: nextNodes,
            nodePing: buildNodePing(nextNodes),
          }
        }),
      autofillIdentityFromEmail: () =>
        set((state) => {
          const email = state.data.ADMIN_EMAIL.trim()
          if (!email.includes('@')) return state
          const prefix = email.split('@')[0]
          const nextFields: Partial<WizardData> = {}
          if (!state.data.ADMIN_USERNAME) nextFields.ADMIN_USERNAME = sanitizeUsername(prefix)
          if (!state.data.ADMIN_NAME) nextFields.ADMIN_NAME = deriveAdminName(prefix)
          if (!state.data.SMTP_TO) nextFields.SMTP_TO = email
          return { data: { ...state.data, ...nextFields } }
        }),
      autofillRepoUrl: () =>
        set((state) => {
          const repo = state.data.GITHUB_REPO.trim()
          if (!repo.includes('/') || state.data.GIT_REPO_URL) return state
          return {
            data: {
              ...state.data,
              GIT_REPO_URL: `https://github.com/${repo}`,
            },
          }
        }),
      setStatus: (status) => set({ status }),
      setLoading: (key, value) =>
        set((state) => ({ loading: { ...state.loading, [key]: value } })),
      setNodePing: (id, value) =>
        set((state) => ({ nodePing: { ...state.nodePing, [id]: value } })),
      setVipPing: (field, value) =>
        set((state) => ({ vipPing: { ...state.vipPing, [field]: value } })),
      setProxmoxDiscovery: (value) => set({ proxmoxDiscovery: value }),
      setProxmoxValidation: (value) => set({ proxmoxValidation: value }),
      setDnsProviderCheck: (value) => set({ dnsProviderCheck: value }),
      setGeneratedPublicKey: (value) => set({ generatedPublicKey: value }),
      addLocalIpRange: () => set((state) => ({ localIpRanges: [...state.localIpRanges, ''] })),
      updateLocalIpRange: (index, value) =>
        set((state) => ({
          localIpRanges: state.localIpRanges.map((range, currentIndex) =>
            currentIndex === index ? value : range,
          ),
        })),
      removeLocalIpRange: (index) =>
        set((state) => {
          const next = state.localIpRanges.filter((_, currentIndex) => currentIndex !== index)
          return { localIpRanges: next.length ? next : [''] }
        }),
      setVpnOnly: (value) => set({ vpnOnly: value }),
      mergeDetectedSubnets: (subnets) => {
        const state = get()
        const nextRanges = [...state.localIpRanges]
        let added = 0
        subnets.forEach((subnet) => {
          if (nextRanges.includes(subnet.cidr)) return
          const emptyIndex = nextRanges.findIndex((value) => !value.trim())
          if (emptyIndex >= 0) nextRanges[emptyIndex] = subnet.cidr
          else nextRanges.push(subnet.cidr)
          added += 1
        })
        set({ localIpRanges: nextRanges.length ? nextRanges : [''], detectedSubnets: subnets, vpnOnly: false })
        return added
      },
      loadFromEnv: (payload) =>
        set((state) => {
          const nextData: WizardData = { ...state.data }
          let nextRanges = state.localIpRanges
          let nextVpnOnly = state.vpnOnly
          let nextNodes = state.nodes.length ? state.nodes : initialNodes.map((node) => ({ ...node }))

          for (const [key, value] of Object.entries(payload)) {
            if (key === 'ENABLE_NETBIRD') nextData.ENABLE_NETBIRD = parseBoolean(value)
            else if (key === 'ENABLE_MONITORING') nextData.ENABLE_MONITORING = parseBoolean(value)
            else if (key === 'ENABLE_EXTERNAL_DNS') nextData.ENABLE_EXTERNAL_DNS = parseBoolean(value)
            else if (key === 'BACKUP_PROVIDER') nextData.BACKUP_PROVIDER = value as BackupProvider
            else if (key === 'DNS_PROVIDER') nextData.DNS_PROVIDER = value as DnsProvider
            else if (key === 'LOCAL_IP_RANGES') {
              if (!value.trim()) {
                nextVpnOnly = true
                nextRanges = ['']
              } else {
                nextVpnOnly = false
                nextRanges = value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
                if (!nextRanges.length) nextRanges = ['']
              }
            } else if (key in nextData) {
              ;(nextData as unknown as Record<string, unknown>)[key] = value
            }
          }

          const parsedNodes: NodeConfig[] = []
          let n = 1
          while (payload[`NODE_${n}_IP`] !== undefined) {
            parsedNodes.push(
              normalizeNode(
                {
                  id: `node-${n}`,
                  ip: payload[`NODE_${n}_IP`] ?? '',
                  vmid: payload[`NODE_${n}_VMID`] ?? String(9309 + n),
                  pveNode: payload[`NODE_${n}_PVE_NODE`] ?? '',
                  datastore: payload[`NODE_${n}_DATASTORE`] ?? '',
                  cpu: payload[`NODE_${n}_CPU`] ?? '4',
                  memory: payload[`NODE_${n}_MEMORY`] ?? '8192',
                  disk: payload[`NODE_${n}_DISK`] ?? '100',
                  role: payload[`NODE_${n}_ROLE`] === 'worker' ? 'worker' : n > 3 ? 'worker' : 'control-plane',
                },
                n - 1,
              ),
            )
            n += 1
          }
          if (parsedNodes.length) nextNodes = parsedNodes

          if (nextData.ADMIN_EMAIL) {
            const prefix = nextData.ADMIN_EMAIL.split('@')[0] ?? ''
            if (!nextData.ADMIN_USERNAME) nextData.ADMIN_USERNAME = sanitizeUsername(prefix)
            if (!nextData.ADMIN_NAME) nextData.ADMIN_NAME = deriveAdminName(prefix)
            if (!nextData.SMTP_TO) nextData.SMTP_TO = nextData.ADMIN_EMAIL
          }

          return {
            data: nextData,
            nodes: nextNodes,
            nodePing: buildNodePing(nextNodes),
            localIpRanges: nextRanges,
            vpnOnly: nextVpnOnly,
            preset: null,
          }
        }),
      getEnvPayload: () => {
        const { data, nodes, localIpRanges, vpnOnly } = get()
        const payload: Record<string, string> = {
          ...Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]),
          ),
          LOCAL_IP_RANGES: vpnOnly ? '' : localIpRanges.map((item) => item.trim()).filter(Boolean).join(','),
          NODE_COUNT: String(nodes.length),
        }
        nodes.forEach((node, index) => {
          const n = index + 1
          payload[`NODE_${n}_IP`] = node.ip
          payload[`NODE_${n}_VMID`] = node.vmid
          payload[`NODE_${n}_PVE_NODE`] = node.pveNode
          payload[`NODE_${n}_DATASTORE`] = node.datastore
          payload[`NODE_${n}_CPU`] = node.cpu
          payload[`NODE_${n}_MEMORY`] = node.memory
          payload[`NODE_${n}_DISK`] = node.disk
          payload[`NODE_${n}_ROLE`] = node.role
        })
        const pveNodes = [...new Set(nodes.map((node) => node.pveNode).filter(Boolean))]
        if (pveNodes.length) {
          payload.PVE_NODES = pveNodes.map((pveName) => `${pveName}:${data.PROXMOX_HOST}`).join(',')
        }
        return payload
      },
      resetDeploy: () =>
        set({
          deployLogs: [],
          deployProgress: 0,
          deployStepText: 'Starting deploy…',
          deployRunning: false,
          deployStarted: false,
          deployId: null,
          deployLastEventSeq: 0,
          deploySummary: '',
          deployError: '',
          deployStages: cloneDeployStages(initialDeployStages),
        }),
      appendDeployLog: (text, level = 'info') =>
        set((state) => ({
          deployLogs: [
            ...state.deployLogs,
            { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text, level },
          ],
        })),
      setDeployState: (state) => set(state),
      setDeployStages: (stages) => set({ deployStages: stages.map((stage) => ({ ...stage })) }),
      updateDeployStage: (name, update) =>
        set((state) => ({
          deployStages: state.deployStages.map((stage) =>
            stage.name === name ? { ...stage, ...update } : stage,
          ),
        })),
      transitionDeployStage: (name) =>
        set((state) => {
          const now = Date.now()
          const nextStages = state.deployStages.map((stage) => ({ ...stage }))
          const runningStage = nextStages.find((stage) => stage.status === 'running')
          if (runningStage && runningStage.name !== name) {
            runningStage.status = 'done'
            runningStage.completedAt = now
          }
          const nextStage = nextStages.find((stage) => stage.name === name)
          if (nextStage) {
            nextStage.status = 'running'
            nextStage.startedAt = nextStage.startedAt ?? now
            nextStage.completedAt = undefined
          }
          return { deployStages: nextStages }
        }),
      finalizeDeployStages: (status) =>
        set((state) => {
          const now = Date.now()
          const nextStages = state.deployStages.map((stage) => ({ ...stage }))
          const runningStage = nextStages.find((stage) => stage.status === 'running')
          if (runningStage) {
            runningStage.status = status
            runningStage.completedAt = now
          }
          return { deployStages: nextStages }
        }),
    }),
    {
      name: 'infraweaver-init-wizard',
      version: 5,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      migrate: (persistedState: unknown, version: number) => {
        const state = (persistedState as PersistedWizardState | null) ?? {}
        if (version < 4) {
          const nextData = sanitizeWizardData(state.data)
          const nextNodes = isNodeConfigArray(state.nodes)
            ? state.nodes.map((node, index) => normalizeNode(node, index))
            : extractLegacyNodes(state.data)
          return {
            ...state,
            currentStep: typeof state.currentStep === 'number' ? state.currentStep : 0,
            data: nextData,
            localIpRanges: Array.isArray(state.localIpRanges) && state.localIpRanges.length ? state.localIpRanges : [''],
            vpnOnly: Boolean(state.vpnOnly),
            generatedPublicKey: typeof state.generatedPublicKey === 'string' ? state.generatedPublicKey : '',
            nodes: nextNodes,
            preset: state.preset === 'dev' || state.preset === 'standard' || state.preset === 'power' ? state.preset : null,
            deployStarted: false,
            deployId: null,
            deployLastEventSeq: 0,
            deployLogs: [],
            deployProgress: 0,
            deployStepText: 'Waiting to deploy…',
            deployRunning: false,
            deploySummary: '',
            deployError: '',
            deployStages: cloneDeployStages(initialDeployStages),
          }
        }
        if (version < 5) {
          return {
            ...state,
            deployStarted: Boolean(state.deployStarted),
            deployId: typeof state.deployId === 'number' ? state.deployId : null,
            deployLastEventSeq: typeof state.deployLastEventSeq === 'number' ? state.deployLastEventSeq : 0,
            deployLogs: Array.isArray(state.deployLogs) ? state.deployLogs : [],
            deployProgress: typeof state.deployProgress === 'number' ? state.deployProgress : 0,
            deployStepText: typeof state.deployStepText === 'string' ? state.deployStepText : 'Waiting to deploy…',
            deployRunning: Boolean(state.deployRunning),
            deploySummary: typeof state.deploySummary === 'string' ? state.deploySummary : '',
            deployError: typeof state.deployError === 'string' ? state.deployError : '',
            deployStages: Array.isArray(state.deployStages) ? state.deployStages.map((stage) => ({ ...stage })) : cloneDeployStages(initialDeployStages),
          }
        }
        return persistedState
      },
      partialize: (state) => ({
        currentStep: state.currentStep,
        data: state.data,
        nodes: state.nodes,
        preset: state.preset,
        localIpRanges: state.localIpRanges,
        vpnOnly: state.vpnOnly,
        generatedPublicKey: state.generatedPublicKey,
        deployStarted: state.deployStarted,
        deployId: state.deployId,
        deployLastEventSeq: state.deployLastEventSeq,
        deployLogs: state.deployLogs,
        deployProgress: state.deployProgress,
        deployStepText: state.deployStepText,
        deployRunning: state.deployRunning,
        deploySummary: state.deploySummary,
        deployError: state.deployError,
        deployStages: state.deployStages,
      }),
    },
  ),
)
