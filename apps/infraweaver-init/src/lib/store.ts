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
  NODE_1_IP: string
  NODE_1_VMID: string
  NODE_2_IP: string
  NODE_2_VMID: string
  NODE_3_IP: string
  NODE_3_VMID: string
  PVE_NODES: string
  NODE_1_PVE_NODE: string
  NODE_1_DATASTORE: string
  NODE_1_CPU: string
  NODE_1_MEMORY: string
  NODE_1_DISK: string
  NODE_2_PVE_NODE: string
  NODE_2_DATASTORE: string
  NODE_2_CPU: string
  NODE_2_MEMORY: string
  NODE_2_DISK: string
  NODE_3_PVE_NODE: string
  NODE_3_DATASTORE: string
  NODE_3_CPU: string
  NODE_3_MEMORY: string
  NODE_3_DISK: string
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

const nodePingFields = ['NODE_1_IP', 'NODE_2_IP', 'NODE_3_IP'] as const
const vipPingFields = [
  'METALLB_TRAEFIK_VIP',
  'METALLB_COREDNS_VIP',
  'METALLB_NETBIRD_MGMT_VIP',
  'METALLB_NETBIRD_SIGNAL_VIP',
  'METALLB_NETBIRD_RELAY_VIP',
] as const

type NodePingField = (typeof nodePingFields)[number]
type VipPingField = (typeof vipPingFields)[number]

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
  NODE_1_IP: '10.10.0.90',
  NODE_1_VMID: '9310',
  NODE_2_IP: '10.10.0.91',
  NODE_2_VMID: '9311',
  NODE_3_IP: '10.10.0.92',
  NODE_3_VMID: '9312',
  PVE_NODES: '',
  NODE_1_PVE_NODE: '',
  NODE_1_DATASTORE: '',
  NODE_1_CPU: '4',
  NODE_1_MEMORY: '8192',
  NODE_1_DISK: '100',
  NODE_2_PVE_NODE: '',
  NODE_2_DATASTORE: '',
  NODE_2_CPU: '4',
  NODE_2_MEMORY: '8192',
  NODE_2_DISK: '100',
  NODE_3_PVE_NODE: '',
  NODE_3_DATASTORE: '',
  NODE_3_CPU: '4',
  NODE_3_MEMORY: '8192',
  NODE_3_DISK: '100',
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
  ENABLE_NETBIRD: false,
  ENABLE_MONITORING: false,
  ENABLE_EXTERNAL_DNS: false,
  BACKUP_PROVIDER: 'longhorn',
}

const emptyNodePing: Record<NodePingField, PingState> = {
  NODE_1_IP: null,
  NODE_2_IP: null,
  NODE_3_IP: null,
}

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

interface WizardStore {
  currentStep: number
  data: WizardData
  localIpRanges: string[]
  vpnOnly: boolean
  status: StatusResponse | null
  nodePing: Record<NodePingField, PingState>
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
  deploySummary: string
  deployError: string
  setCurrentStep: (step: number) => void
  setField: <K extends keyof WizardData>(key: K, value: WizardData[K]) => void
  setFields: (fields: Partial<WizardData>) => void
  autofillIdentityFromEmail: () => void
  autofillRepoUrl: () => void
  setStatus: (status: StatusResponse | null) => void
  setLoading: (key: keyof typeof emptyLoadingState, value: boolean) => void
  setNodePing: (field: NodePingField, value: PingState) => void
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
  setDeployState: (state: Partial<Pick<WizardStore, 'deployProgress' | 'deployStepText' | 'deployRunning' | 'deploySummary' | 'deployError'>>) => void
}

export function isWizardDataPristine(data: WizardData) {
  return !data.BASE_DOMAIN && !data.PROXMOX_API_TOKEN && !data.DEPLOYER_SSH_KEY && !data.CLOUDFLARE_API_TOKEN && !data.SMTP_USERNAME && data.DNS_PROVIDER === 'cloudflare'
}

export const useWizardStore = create<WizardStore>()(
  persist(
    (set, get) => ({
      currentStep: 0,
      data: initialWizardData,
      localIpRanges: [''],
      vpnOnly: false,
      status: null,
      nodePing: emptyNodePing,
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
      deploySummary: '',
      deployError: '',
      setCurrentStep: (step) => set({ currentStep: step }),
      setField: (key, value) =>
        set((state) => ({
          data: {
            ...state.data,
            [key]: value,
          },
        })),
      setFields: (fields) => set((state) => ({ data: { ...state.data, ...fields } })),
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
      setNodePing: (field, value) =>
        set((state) => ({ nodePing: { ...state.nodePing, [field]: value } })),
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

          if (nextData.ADMIN_EMAIL) {
            const prefix = nextData.ADMIN_EMAIL.split('@')[0] ?? ''
            if (!nextData.ADMIN_USERNAME) nextData.ADMIN_USERNAME = sanitizeUsername(prefix)
            if (!nextData.ADMIN_NAME) nextData.ADMIN_NAME = deriveAdminName(prefix)
            if (!nextData.SMTP_TO) nextData.SMTP_TO = nextData.ADMIN_EMAIL
          }

          return { data: nextData, localIpRanges: nextRanges, vpnOnly: nextVpnOnly }
        }),
      getEnvPayload: () => {
        const { data, localIpRanges, vpnOnly } = get()
        return {
          ...Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]),
          ),
          LOCAL_IP_RANGES: vpnOnly ? '' : localIpRanges.map((item) => item.trim()).filter(Boolean).join(','),
        }
      },
      resetDeploy: () =>
        set({
          deployLogs: [],
          deployProgress: 0,
          deployStepText: 'Starting deploy…',
          deployRunning: false,
          deploySummary: '',
          deployError: '',
        }),
      appendDeployLog: (text, level = 'info') =>
        set((state) => ({
          deployLogs: [
            ...state.deployLogs,
            { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text, level },
          ],
        })),
      setDeployState: (state) => set(state),
    }),
    {
      name: 'infraweaver-init-wizard',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { data?: Partial<WizardData>; [key: string]: unknown }
        if (version < 3) {
          return { ...state, data: { ...initialWizardData, ...(state.data ?? {}) } }
        }
        return persistedState
      },
      partialize: (state) => ({
        currentStep: state.currentStep,
        data: state.data,
        localIpRanges: state.localIpRanges,
        vpnOnly: state.vpnOnly,
        generatedPublicKey: state.generatedPublicKey,
      }),
    },
  ),
)
