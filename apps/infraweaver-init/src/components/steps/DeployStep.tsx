'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Save,
  Upload,
  XCircle,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { deployStream, getKubeconfig, getStatus, pingProxmox, saveEnv } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { downloadEnvFile, parseEnvText, readFileText } from '@/lib/env'
import { classifyLog, isIPv4, staggerContainer } from '@/lib/utils'
import { initialDeployStages, useWizardStore } from '@/lib/store'

type CheckStatus = 'pending' | 'checking' | 'ok' | 'warn' | 'fail'

interface ReadinessCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  hint: string
}

const stageOrder = initialDeployStages.map((stage) => stage.name)

const serviceLinks = [
  { name: 'InfraWeaver Console', path: 'console', icon: '🖥️' },
  { name: 'ArgoCD', path: 'argocd', icon: '🔄' },
  { name: 'Authentik', path: 'authentik', icon: '👤' },
  { name: 'Grafana', path: 'grafana', icon: '📊', requires: 'ENABLE_MONITORING' as const },
  { name: 'Onedev', path: 'git', icon: '📦' },
  { name: 'OpenBao', path: 'bao', icon: '🔐' },
]

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return `${hours}h ${remainingMinutes}m`
  }
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function statusIcon(status: CheckStatus) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-[var(--az-success)]" />
  if (status === 'warn') return <AlertTriangle className="h-4 w-4 text-[var(--az-warning)]" />
  if (status === 'fail') return <XCircle className="h-4 w-4 text-[var(--az-danger)]" />
  if (status === 'checking') return <LoaderCircle className="h-4 w-4 animate-spin text-[var(--az-primary)]" />
  return <ChevronRight className="h-4 w-4 text-[var(--az-text-secondary)]" />
}

function stageIcon(status: 'pending' | 'running' | 'done' | 'failed') {
  if (status === 'done') return '✅'
  if (status === 'running') return '🔄'
  if (status === 'failed') return '❌'
  return '⏳'
}

export function DeployStep() {
  const data = useWizardStore((state) => state.data)
  const nodes = useWizardStore((state) => state.nodes)
  const status = useWizardStore((state) => state.status)
  const loading = useWizardStore((state) => state.loading)
  const proxmoxDiscovery = useWizardStore((state) => state.proxmoxDiscovery)
  const proxmoxValidation = useWizardStore((state) => state.proxmoxValidation)
  const deployLogs = useWizardStore((state) => state.deployLogs)
  const deployProgress = useWizardStore((state) => state.deployProgress)
  const deployStepText = useWizardStore((state) => state.deployStepText)
  const deploySummary = useWizardStore((state) => state.deploySummary)
  const deployError = useWizardStore((state) => state.deployError)
  const deployRunning = useWizardStore((state) => state.deployRunning)
  const deployStages = useWizardStore((state) => state.deployStages)
  const setStatus = useWizardStore((state) => state.setStatus)
  const getEnvPayload = useWizardStore((state) => state.getEnvPayload)
  const setLoading = useWizardStore((state) => state.setLoading)
  const resetDeploy = useWizardStore((state) => state.resetDeploy)
  const appendDeployLog = useWizardStore((state) => state.appendDeployLog)
  const setDeployState = useWizardStore((state) => state.setDeployState)
  const setDeployStages = useWizardStore((state) => state.setDeployStages)
  const updateDeployStage = useWizardStore((state) => state.updateDeployStage)
  const loadFromEnv = useWizardStore((state) => state.loadFromEnv)

  const [saveMessage, setSaveMessage] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set())
  const [proxmoxReachability, setProxmoxReachability] = useState<{ status: CheckStatus; detail: string }>({
    status: 'pending',
    detail: 'Run a Proxmox reachability check from this step.',
  })
  const [ticker, setTicker] = useState(Date.now())
  const logRef = useRef<HTMLDivElement>(null)
  const stageAnchors = useRef<Record<string, number>>({})
  const logLineRefs = useRef<Array<HTMLDivElement | null>>([])
  const importInputRef = useRef<HTMLInputElement>(null)

  const totalClusterRamMb = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.memory || 0), 0),
    [nodes],
  )
  const totalClusterDiskGb = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.disk || 0), 0),
    [nodes],
  )
  const controlPlaneCount = useMemo(
    () => nodes.filter((node) => node.role === 'control-plane').length,
    [nodes],
  )

  const resourceWarn = useMemo(() => {
    if (!proxmoxDiscovery?.node_memory_free_mb) return false
    const ramPressure = totalClusterRamMb / proxmoxDiscovery.node_memory_free_mb
    const diskPressure = proxmoxDiscovery.node_disk_free_gb ? totalClusterDiskGb / proxmoxDiscovery.node_disk_free_gb : 0
    return ramPressure > 0.8 || diskPressure > 0.8
  }, [proxmoxDiscovery?.node_disk_free_gb, proxmoxDiscovery?.node_memory_free_mb, totalClusterDiskGb, totalClusterRamMb])

  useEffect(() => {
    void refreshStatusAndChecks()
  }, [])

  useEffect(() => {
    if (data.PROXMOX_HOST.trim()) {
      void runProxmoxCheck()
    }
  }, [data.PROXMOX_HOST])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [deployLogs])

  useEffect(() => {
    if (!deployRunning) return
    const timer = window.setInterval(() => setTicker(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deployRunning])

  const refreshStatus = async () => {
    const nextStatus = await getStatus()
    setStatus(nextStatus)
    return nextStatus
  }

  const runProxmoxCheck = async () => {
    if (!data.PROXMOX_HOST.trim()) {
      setProxmoxReachability({ status: 'pending', detail: 'Enter a Proxmox host to test connectivity.' })
      return
    }
    setProxmoxReachability({ status: 'checking', detail: `Checking https://${data.PROXMOX_HOST}:8006/api2/json/version` })
    try {
      const result = await pingProxmox(data.PROXMOX_HOST.trim())
      if (result.ok) {
        setProxmoxReachability({
          status: 'ok',
          detail: `Reachable${result.version ? ` · version ${result.version}` : ''}${result.release ? ` (${result.release})` : ''}`,
        })
      } else {
        setProxmoxReachability({ status: 'fail', detail: result.error ?? 'Proxmox did not respond.' })
      }
    } catch (error) {
      setProxmoxReachability({ status: 'fail', detail: error instanceof Error ? error.message : 'Proxmox did not respond.' })
    }
  }

  const refreshStatusAndChecks = async () => {
    await Promise.all([refreshStatus(), runProxmoxCheck()])
  }

  const handleSaveEnv = async (silent = false) => {
    setLoading('saveEnv', true)
    try {
      const result = await saveEnv(getEnvPayload())
      if (result.ok) {
        const nextStatus = await refreshStatus()
        if (!silent) setSaveMessage(nextStatus.env_saved ? '.env saved and ready for deploy.' : '.env saved.')
        return true
      }
      if (!silent) setSaveMessage(result.error ?? 'Unable to save .env')
      return false
    } catch (error) {
      if (!silent) setSaveMessage(error instanceof Error ? error.message : 'Unable to save .env')
      return false
    } finally {
      setLoading('saveEnv', false)
    }
  }

  const transitionToStage = (name: string) => {
    const now = Date.now()
    const currentStages = useWizardStore.getState().deployStages.map((stage) => ({ ...stage }))
    const runningStage = currentStages.find((stage) => stage.status === 'running')
    if (runningStage && runningStage.name !== name) {
      runningStage.status = 'done'
      runningStage.completedAt = now
    }
    const nextStage = currentStages.find((stage) => stage.name === name)
    if (nextStage) {
      nextStage.status = 'running'
      nextStage.startedAt = nextStage.startedAt ?? now
      nextStage.completedAt = undefined
    }
    setDeployStages(currentStages)
  }

  const finalizeStages = (status: 'done' | 'failed') => {
    const now = Date.now()
    const currentStages = useWizardStore.getState().deployStages.map((stage) => ({ ...stage }))
    const runningStage = currentStages.find((stage) => stage.status === 'running')
    if (runningStage) {
      runningStage.status = status
      runningStage.completedAt = now
    }
    setDeployStages(currentStages)
  }

  const startDeploy = async (mode: 'deploy' | 'redeploy') => {
    const saved = await handleSaveEnv(true)
    if (!saved) {
      setSaveMessage('Save failed. Fix the form and try again.')
      return
    }

    stageAnchors.current = {}
    logLineRefs.current = []
    resetDeploy()
    setDeployStages(initialDeployStages.map((stage) => ({ ...stage })))
    setDeployState({ deployRunning: true, deployProgress: 0, deployStepText: mode === 'redeploy' ? 'Starting redeploy…' : 'Starting deploy…', deploySummary: '', deployError: '' })
    setLoading('deploy', true)
    appendDeployLog(`==> ${mode === 'redeploy' ? 'Redeploying' : 'Deploying'} ${data.K8S_CLUSTER_NAME} from ${data.PROXMOX_HOST}`, 'step')
    setActionMessage('')

    try {
      await deployStream(mode, (event) => {
        if (event.type === 'log') {
          if (event.text.startsWith('STAGE:')) {
            const stageName = event.text.slice(6).trim()
            const stage = initialDeployStages.find((item) => item.name === stageName)
            if (stage) {
              stageAnchors.current[stageName] = useWizardStore.getState().deployLogs.length
              appendDeployLog(`==> ${stage.label}`, 'step')
              transitionToStage(stageName)
            }
            return
          }
          appendDeployLog(event.text, classifyLog(event.text))
          return
        }

        if (event.type === 'progress') {
          setDeployState({ deployProgress: event.pct, deployStepText: event.step })
          return
        }

        if (event.type === 'done') {
          finalizeStages('done')
          appendDeployLog('✅ Deployment complete!', 'ok')
          if (event.summary) appendDeployLog(event.summary, 'ok')
          setDeployState({
            deployRunning: false,
            deployProgress: 100,
            deployStepText: 'Complete!',
            deploySummary: event.summary ?? 'Platform deployed successfully!',
            deployError: '',
          })
          return
        }

        if (event.type === 'error') {
          finalizeStages('failed')
          appendDeployLog(`✗ ${event.text}`, 'err')
          setDeployState({ deployRunning: false, deployError: event.text, deploySummary: '', deployStepText: 'Deploy failed' })
        }
      })
      await refreshStatusAndChecks()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deploy failed'
      finalizeStages('failed')
      appendDeployLog(`✗ ${message}`, 'err')
      setDeployState({ deployRunning: false, deployError: message, deploySummary: '', deployStepText: 'Deploy failed' })
    } finally {
      setLoading('deploy', false)
    }
  }

  const readinessChecks = useMemo<ReadinessCheck[]>(() => {
    const dnsReady = Boolean(
      status?.dns_provider_configured ||
        data.DNS_PROVIDER === 'none' ||
        (data.DNS_PROVIDER === 'cloudflare' && data.CLOUDFLARE_API_TOKEN.trim()) ||
        (data.DNS_PROVIDER === 'route53' && data.AWS_ACCESS_KEY_ID.trim() && data.AWS_SECRET_ACCESS_KEY.trim()) ||
        (data.DNS_PROVIDER === 'azure' && data.AZURE_CLIENT_ID.trim() && data.AZURE_CLIENT_SECRET.trim()) ||
        (data.DNS_PROVIDER === 'digitalocean' && data.DIGITALOCEAN_TOKEN.trim()) ||
        (data.DNS_PROVIDER === 'hetzner' && data.HETZNER_DNS_API_KEY.trim()),
    )
    const nodeIpsValid = nodes.every((node) => node.ip.trim() && isIPv4(node.ip))

    return [
      {
        id: 'env-saved',
        label: '.env file saved',
        status: status?.env_saved ? 'ok' : 'fail',
        detail: status?.env_saved ? 'The latest wizard state is saved into the repository .env file.' : 'Save the current configuration before deploying.',
        hint: 'Use “Save .env” before deploy.',
      },
      {
        id: 'ssh-key',
        label: 'SSH key configured',
        status: status?.ssh_key || data.DEPLOYER_SSH_KEY.trim() ? 'ok' : 'fail',
        detail: data.DEPLOYER_SSH_KEY.trim() ? 'A deployer SSH key is present in the wizard state.' : 'Paste or generate an SSH private key in the credentials step.',
        hint: 'Step 6 → SSH keypair.',
      },
      {
        id: 'domain',
        label: 'Domain configured',
        status: status?.domain || data.BASE_DOMAIN.trim() ? 'ok' : 'fail',
        detail: data.BASE_DOMAIN.trim() ? `Base domain: ${data.BASE_DOMAIN}` : 'No base domain has been entered yet.',
        hint: 'Step 2 → Domain & Email.',
      },
      {
        id: 'dns',
        label: 'DNS provider configured',
        status: dnsReady ? 'ok' : 'fail',
        detail: dnsReady ? `Provider ${data.DNS_PROVIDER} has the required credentials.` : `Missing credentials for ${data.DNS_PROVIDER}.`,
        hint: 'Step 6 → DNS provider.',
      },
      {
        id: 'proxmox-reachable',
        label: 'Proxmox reachable',
        status: proxmoxReachability.status,
        detail: proxmoxReachability.detail,
        hint: 'Refresh this checklist or validate the API token again.',
      },
      {
        id: 'control-plane',
        label: 'Cluster has ≥1 control-plane node',
        status: controlPlaneCount >= 1 ? 'ok' : 'fail',
        detail: `${controlPlaneCount} control-plane node${controlPlaneCount === 1 ? '' : 's'} configured.`,
        hint: 'Cluster step → keep at least one control-plane node.',
      },
      {
        id: 'node-ips',
        label: 'All node IPs are set',
        status: nodeIpsValid ? 'ok' : 'fail',
        detail: nodeIpsValid ? 'Every node has a valid IPv4 address.' : 'One or more nodes are missing a valid IPv4 address.',
        hint: 'Cluster step → node pool cards.',
      },
      {
        id: 'ha-warning',
        label: 'HA warning',
        status: controlPlaneCount >= 3 ? 'ok' : 'warn',
        detail: controlPlaneCount >= 3 ? 'Three or more control-plane nodes detected for HA.' : 'Fewer than 3 control-plane nodes means no HA control plane.',
        hint: 'Add more control-plane nodes for resilient upgrades.',
      },
      {
        id: 'vip-range',
        label: 'MetalLB VIP range set',
        status: data.METALLB_VIP_RANGE.trim() ? 'ok' : 'fail',
        detail: data.METALLB_VIP_RANGE.trim() ? `VIP range: ${data.METALLB_VIP_RANGE}` : 'No MetalLB VIP range configured.',
        hint: 'Cluster step → MetalLB VIP plan.',
      },
      {
        id: 'resource-check',
        label: 'Proxmox resource check',
        status: proxmoxDiscovery ? (resourceWarn ? 'warn' : 'ok') : 'pending',
        detail: proxmoxDiscovery
          ? resourceWarn
            ? `Cluster requests ${(totalClusterRamMb / 1024).toFixed(1)} GB RAM / ${totalClusterDiskGb.toFixed(1)} GB disk, which is over 80% of the discovered free capacity.`
            : `Cluster requests ${(totalClusterRamMb / 1024).toFixed(1)} GB RAM / ${totalClusterDiskGb.toFixed(1)} GB disk and fits comfortably in discovered capacity.`
          : 'Run Proxmox discovery to compare requested resources against the host.',
        hint: 'Step 3 → Discover from Proxmox.',
      },
      {
        id: 'deploy-idle',
        label: 'Deploy currently idle',
        status: status?.deploy_running ? 'warn' : 'ok',
        detail: status?.deploy_running ? 'The init server reports a deploy already in progress.' : 'No active deploy job is running.',
        hint: 'Wait for the current deploy to finish before starting another.',
      },
      {
        id: 'proxmox-api',
        label: 'Proxmox API checked',
        status: status?.proxmox || proxmoxValidation?.ok || proxmoxDiscovery?.ok ? 'ok' : 'pending',
        detail: proxmoxValidation?.ok || proxmoxDiscovery?.ok ? 'Validation/discovery succeeded in this session.' : 'No successful API validation recorded yet.',
        hint: 'Use Validate API or Discover from Proxmox.',
      },
    ]
  }, [
    controlPlaneCount,
    data.AWS_ACCESS_KEY_ID,
    data.AWS_SECRET_ACCESS_KEY,
    data.AZURE_CLIENT_ID,
    data.AZURE_CLIENT_SECRET,
    data.BASE_DOMAIN,
    data.CLOUDFLARE_API_TOKEN,
    data.DEPLOYER_SSH_KEY,
    data.DIGITALOCEAN_TOKEN,
    data.DNS_PROVIDER,
    data.HETZNER_DNS_API_KEY,
    data.METALLB_VIP_RANGE,
    nodes,
    proxmoxDiscovery,
    proxmoxReachability.detail,
    proxmoxReachability.status,
    proxmoxValidation?.ok,
    resourceWarn,
    status,
    totalClusterDiskGb,
    totalClusterRamMb,
  ])

  const visibleServiceLinks = useMemo(
    () =>
      serviceLinks.filter((link) => {
        if (link.requires === 'ENABLE_MONITORING') return data.ENABLE_MONITORING
        return true
      }),
    [data.ENABLE_MONITORING],
  )

  const handleExport = () => {
    downloadEnvFile(getEnvPayload())
    setActionMessage('Exported the current wizard state as .env.')
  }

  const handleImportClick = () => importInputRef.current?.click()

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const content = await readFileText(file)
    loadFromEnv(parseEnvText(content))
    setActionMessage(`Imported ${file.name}.`)
    event.target.value = ''
  }

  const handleCopyKubeconfig = async () => {
    try {
      const result = await getKubeconfig()
      if (result.ok && result.kubeconfig) {
        await navigator.clipboard.writeText(result.kubeconfig)
        setActionMessage('Kubeconfig copied to clipboard.')
      } else {
        setActionMessage(result.error ?? 'kubeconfig not available yet.')
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to fetch kubeconfig.')
    }
  }

  const handleRedeploy = async () => {
    if (!window.confirm('Redeploy from scratch? This will rerun the full pipeline.')) return
    await startDeploy('redeploy')
  }

  const toggleCheck = (id: string) => {
    setExpandedChecks((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Rocket}
        eyebrow="Step 8 of 8"
        title="Review, save, and deploy"
        description="Run one last pre-flight pass against the init server, write the current wizard state to the repository .env file, and stream deploy progress directly from the existing server-side SSE endpoint."
      />

      {!deployRunning && deploySummary ? (
        <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <GlassCard className="p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="text-2xl">✨</div>
              <div>
                <div className="text-lg font-semibold text-white">Service quick links</div>
                <div className="text-sm text-[var(--az-text-secondary)]">Jump directly into the freshly deployed platform services.</div>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {visibleServiceLinks.map((link) => {
                const href = `https://${link.path}.${data.BASE_DOMAIN}`
                return (
                  <div key={link.name} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-lg">{link.icon}</div>
                        <div className="mt-2 text-sm font-semibold text-white">{link.name}</div>
                        <div className="mt-1 break-all text-xs text-[var(--az-text-secondary)]">{href}</div>
                      </div>
                      <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition hover:border-white/20 hover:bg-white/10">
                        Open
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          </GlassCard>

          <GlassCard className="p-6">
            <div className="mb-5 text-lg font-semibold text-white">Actions</div>
            <div className="flex flex-wrap gap-3">
              <ActionButton variant="secondary" onClick={() => void handleCopyKubeconfig()}>
                <Copy className="h-4 w-4" />
                📋 Copy kubeconfig
              </ActionButton>
              <ActionButton variant="danger" onClick={() => void handleRedeploy()} disabled={loading.deploy || deployRunning}>
                <Rocket className="h-4 w-4" />
                🔄 Redeploy from scratch
              </ActionButton>
              <ActionButton variant="secondary" onClick={handleExport}>
                <Download className="h-4 w-4" />
                📤 Export .env
              </ActionButton>
              <ActionButton variant="secondary" onClick={handleImportClick}>
                <Upload className="h-4 w-4" />
                📥 Import .env
              </ActionButton>
            </div>
            {actionMessage ? <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-[var(--az-text-secondary)]">{actionMessage}</div> : null}
          </GlassCard>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <GlassCard className="p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">Pre-flight readiness checklist</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Live checks across the wizard state, init server status, and discovered Proxmox capacity.</div>
            </div>
            <ActionButton variant="secondary" onClick={() => void refreshStatusAndChecks()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </ActionButton>
          </div>

          <div className="space-y-3">
            {readinessChecks.map((item) => {
              const expanded = expandedChecks.has(item.id)
              return (
                <div key={item.id} className={`rounded-2xl border ${item.status === 'ok' ? 'border-[rgba(87,163,0,0.18)] bg-[rgba(87,163,0,0.08)]' : item.status === 'warn' ? 'border-[rgba(212,117,0,0.25)] bg-[rgba(212,117,0,0.08)]' : item.status === 'fail' ? 'border-[rgba(209,52,56,0.2)] bg-[rgba(209,52,56,0.08)]' : 'border-white/8 bg-black/20'}`}>
                  <button type="button" onClick={() => toggleCheck(item.id)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
                    <div className="flex items-center gap-3">
                      {statusIcon(item.status)}
                      <span className="text-sm text-white">{item.label}</span>
                    </div>
                    {expanded ? <ChevronDown className="h-4 w-4 text-[var(--az-text-secondary)]" /> : <ChevronRight className="h-4 w-4 text-[var(--az-text-secondary)]" />}
                  </button>
                  {expanded ? (
                    <div className="border-t border-white/6 px-4 py-3 text-sm text-[var(--az-text-secondary)]">
                      <div>{item.detail}</div>
                      <div className="mt-2 text-xs uppercase tracking-[0.18em] text-[var(--az-text-secondary)]">Hint · {item.hint}</div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <ActionButton variant="secondary" onClick={() => void handleSaveEnv()} disabled={loading.saveEnv || deployRunning}>
              {loading.saveEnv ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              💾 Save .env
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleExport}>
              <Download className="h-4 w-4" />
              📤 Export .env
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleImportClick}>
              <Upload className="h-4 w-4" />
              📥 Import .env
            </ActionButton>
            <ActionButton variant="primary" onClick={() => void startDeploy('deploy')} disabled={loading.deploy || deployRunning}>
              {loading.deploy || deployRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              🚀 Deploy Cluster
            </ActionButton>
          </div>
          <input ref={importInputRef} type="file" accept=".env,text/plain" className="hidden" onChange={(event) => void handleImport(event)} />

          {saveMessage ? <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-[var(--az-text-secondary)]">{saveMessage}</div> : null}
          {deploySummary ? (
            <div className="mt-4 rounded-2xl border border-[rgba(87,163,0,0.22)] bg-[rgba(87,163,0,0.08)] px-4 py-3 text-sm text-[var(--az-success)]">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{deploySummary}</span>
              </div>
            </div>
          ) : null}
          {deployError ? (
            <div className="mt-4 rounded-2xl border border-[rgba(209,52,56,0.22)] bg-[rgba(209,52,56,0.08)] px-4 py-3 text-sm text-[var(--az-danger)]">
              {deployError}
            </div>
          ) : null}
          {actionMessage && !deploySummary ? (
            <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-[var(--az-text-secondary)]">{actionMessage}</div>
          ) : null}
        </GlassCard>

        <GlassCard className="p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">Deploy pipeline dashboard</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Parsed from <code>STAGE:*</code> markers in the deploy stream.</div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
              {deployStepText}
            </div>
          </div>

          <div className="mb-5 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {deployStages.map((stage, index) => {
              const anchorIndex = stageAnchors.current[stage.name]
              const duration = stage.completedAt
                ? stage.completedAt - (stage.startedAt ?? stage.completedAt)
                : stage.status === 'running'
                  ? ticker - (stage.startedAt ?? ticker)
                  : undefined
              return (
                <button
                  key={stage.name}
                  type="button"
                  onClick={() => {
                    if (anchorIndex === undefined) return
                    logLineRefs.current[anchorIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }}
                  className={`rounded-2xl border p-4 text-left transition ${stage.status === 'running' ? 'border-[rgba(0,120,212,0.45)] bg-[rgba(0,120,212,0.14)]' : stage.status === 'done' ? 'border-[rgba(87,163,0,0.24)] bg-[rgba(87,163,0,0.08)]' : stage.status === 'failed' ? 'border-[rgba(209,52,56,0.22)] bg-[rgba(209,52,56,0.08)]' : 'border-white/8 bg-black/20'} ${anchorIndex === undefined ? 'cursor-default' : 'hover:border-white/20 hover:bg-black/30'}`}
                >
                  <div className="text-xs text-[var(--az-text-secondary)]">{index < stageOrder.length - 1 ? `${stageIcon(stage.status)} ${stage.name}` : `${stageIcon(stage.status)} ${stage.name}`}</div>
                  <div className="mt-2 text-sm font-semibold text-white">{stage.label}</div>
                  <div className="mt-2 text-xs text-[var(--az-text-secondary)]">{stage.status}</div>
                  <div className="mt-1 text-xs text-[var(--az-text-secondary)]">{formatDuration(duration)}</div>
                </button>
              )
            })}
          </div>

          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--az-text-secondary)]">
              <span>Deployment progress</span>
              <span>{deployProgress}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full border border-white/8 bg-black/25">
              <div
                className="progress-shine relative h-full rounded-full bg-[linear-gradient(90deg,#0078D4,#3ea6ff)] transition-[width] duration-500"
                style={{ width: `${deployProgress}%` }}
              />
            </div>
          </div>

          <div ref={logRef} className="terminal-surface custom-scrollbar h-[420px] overflow-y-auto rounded-2xl border border-white/8 px-4 py-4 font-mono text-xs leading-6 text-[#b7f397] shadow-[inset_0_0_40px_rgba(0,0,0,0.35)]">
            {deployLogs.length ? (
              deployLogs.map((line, index) => (
                <div
                  key={line.id}
                  ref={(element) => {
                    logLineRefs.current[index] = element
                  }}
                  className={`whitespace-pre-wrap ${line.level === 'ok' ? 'text-[#8be26e]' : ''} ${line.level === 'warn' ? 'text-[#f0c96b]' : ''} ${line.level === 'err' ? 'text-[#ff7b7b]' : ''} ${line.level === 'step' ? 'text-[#8fc9ff]' : ''}`}
                >
                  {line.text}
                </div>
              ))
            ) : (
              <div className="text-[var(--az-text-secondary)]">Waiting for deployment to start…</div>
            )}
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
