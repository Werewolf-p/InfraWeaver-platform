'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw,
  BarChart3,
  Boxes,
  Globe,
  KeyRound,
  RefreshCw,
  Rocket,
  Server,
  Settings2,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { ActionButton } from '@/components/ui/ActionButton'
import { ExpertEnvModal } from '@/components/ExpertEnvModal'
import { WizardShell, type WizardStepMeta } from '@/components/WizardShell'
import { ClusterStep } from '@/components/steps/ClusterStep'
import { CredentialsStep } from '@/components/steps/CredentialsStep'
import { DeployStep } from '@/components/steps/DeployStep'
import { DomainStep } from '@/components/steps/DomainStep'
import { FeaturesStep } from '@/components/steps/FeaturesStep'
import { IdentityStep } from '@/components/steps/IdentityStep'
import { ProxmoxStep } from '@/components/steps/ProxmoxStep'
import { WelcomeStep } from '@/components/steps/WelcomeStep'
import { RestoreStep } from '@/components/steps/RestoreStep'
import { connectDeployEvents, getStatus, loadEnv, selfUpdate, type DeployEvent } from '@/lib/api'
import { initialDeployStages, initialWizardData, isWizardDataPristine, useWizardStore } from '@/lib/store'
import { classifyLog, isCIDR, isDomain, isEmail, isIPv4, isPositiveInteger } from '@/lib/utils'
import type { DnsProvider } from '@/lib/store'

function hasDnsProviderCredentials(data: typeof initialWizardData): boolean {
  switch (data.DNS_PROVIDER as DnsProvider) {
    case 'cloudflare':
      return data.CLOUDFLARE_API_TOKEN.trim().length > 0
    case 'route53':
      return data.AWS_ACCESS_KEY_ID.trim().length > 0 && data.AWS_SECRET_ACCESS_KEY.trim().length > 0
    case 'azure':
      return (
        data.AZURE_CLIENT_ID.trim().length > 0 &&
        data.AZURE_CLIENT_SECRET.trim().length > 0 &&
        data.AZURE_SUBSCRIPTION_ID.trim().length > 0 &&
        data.AZURE_TENANT_ID.trim().length > 0 &&
        data.AZURE_RESOURCE_GROUP.trim().length > 0
      )
    case 'digitalocean':
      return data.DIGITALOCEAN_TOKEN.trim().length > 0
    case 'hetzner':
      return data.HETZNER_DNS_API_KEY.trim().length > 0
    case 'none':
      return true
    default:
      return false
  }
}

const BASE_STEPS: Array<WizardStepMeta & { icon: React.ComponentType<{ className?: string }> }> = [
  { title: 'Welcome', icon: Sparkles },
  { title: 'Domain & Email', shortTitle: 'Domain', icon: Globe },
  { title: 'Proxmox', icon: Server },
  { title: 'Cluster Topology', shortTitle: 'Cluster', icon: Boxes },
  { title: 'Identity', icon: UserRound },
  { title: 'Credentials', icon: KeyRound },
  { title: 'Features', icon: Settings2 },
]

function isStepValid(step: number, data: typeof initialWizardData, nodes: ReturnType<typeof useWizardStore.getState>['nodes'], localIpRanges: string[], vpnOnly: boolean, hasRestoreStep = false) {
  const controlPlaneCount = nodes.filter((node) => node.role === 'control-plane').length

  switch (step) {
    case 0:
      return true
    case 1:
      return isDomain(data.BASE_DOMAIN) && isEmail(data.ADMIN_EMAIL)
    case 2:
      return isIPv4(data.PROXMOX_HOST) && data.PROXMOX_API_TOKEN.trim().length > 0 && data.PROXMOX_NODE_NAME.trim().length > 0
    case 3:
      return (
        data.K8S_CLUSTER_NAME.trim().length > 0 &&
        data.TALOS_DATASTORE.trim().length > 0 &&
        isIPv4(data.NODE_GATEWAY) &&
        isPositiveInteger(data.NODE_SUBNET_PREFIX) &&
        nodes.length > 0 &&
        controlPlaneCount >= 1 &&
        nodes.every((node) => isIPv4(node.ip) && isPositiveInteger(node.vmid)) &&
        data.METALLB_VIP_RANGE.trim().length > 0 &&
        isIPv4(data.METALLB_TRAEFIK_VIP) &&
        isIPv4(data.METALLB_COREDNS_VIP) &&
        isIPv4(data.METALLB_NETBIRD_MGMT_VIP) &&
        isIPv4(data.METALLB_NETBIRD_SIGNAL_VIP) &&
        isIPv4(data.METALLB_NETBIRD_RELAY_VIP) &&
        data.CLUSTER_LOCAL_DOMAIN.trim().length > 0
      )
    case 4:
      return /^[a-z0-9_-]+$/.test(data.ADMIN_USERNAME.trim()) && data.ADMIN_NAME.trim().length > 0
    case 5:
      return (
        data.DEPLOYER_SSH_KEY.trim().length > 0 &&
        hasDnsProviderCredentials(data) &&
        isEmail(data.SMTP_USERNAME) &&
        data.SMTP_PASSWORD.trim().length > 0 &&
        isEmail(data.SMTP_TO || data.ADMIN_EMAIL) &&
        data.GITHUB_REPO.trim().length > 0 &&
        data.GIT_REPO_URL.trim().length > 0
      )
    case 6:
      return vpnOnly || localIpRanges.filter((range) => range.trim()).every((range) => isCIDR(range))
    case 7:
      return true
    case 8:
      // Deploy step when restore is inserted
      return hasRestoreStep
    default:
      return false
  }
}

function applyDeployEventToStore(event: DeployEvent) {
  const store = useWizardStore.getState()
  if (typeof event.deploymentId === 'number' || typeof event.seq === 'number') {
    store.setDeployState({
      deployStarted: true,
      deployId: typeof event.deploymentId === 'number' ? event.deploymentId : store.deployId,
      deployLastEventSeq: typeof event.seq === 'number' ? Math.max(store.deployLastEventSeq, event.seq) : store.deployLastEventSeq,
    })
  }

  if (event.type === 'log') {
    if (event.text.startsWith('STAGE:')) {
      const stageName = event.text.slice(6).trim()
      const stage = initialDeployStages.find((item) => item.name === stageName)
      if (stage) {
        store.appendDeployLog(`==> ${stage.label}`, 'step')
        store.transitionDeployStage(stageName)
      }
      return
    }
    store.appendDeployLog(event.text, classifyLog(event.text))
    return
  }

  if (event.type === 'progress') {
    store.setDeployState({ deployProgress: event.pct, deployStepText: event.step, deployRunning: true, deployStarted: true })
    return
  }

  if (event.type === 'done') {
    store.finalizeDeployStages('done')
    store.appendDeployLog('✅ Deployment complete!', 'ok')
    if (event.summary) store.appendDeployLog(event.summary, 'ok')
    store.setDeployState({
      deployRunning: false,
      deployProgress: 100,
      deployStepText: 'Complete!',
      deploySummary: event.summary ?? 'Platform deployed successfully!',
      deployError: '',
    })
    return
  }

  if (event.type === 'error') {
    store.finalizeDeployStages('failed')
    store.appendDeployLog(`✗ ${event.text}`, 'err')
    store.setDeployState({ deployRunning: false, deployError: event.text, deploySummary: '', deployStepText: 'Deploy failed' })
  }
}

export default function HomePage() {
  const currentStep = useWizardStore((state) => state.currentStep)
  const data = useWizardStore((state) => state.data)
  const nodes = useWizardStore((state) => state.nodes)
  const localIpRanges = useWizardStore((state) => state.localIpRanges)
  const vpnOnly = useWizardStore((state) => state.vpnOnly)
  const status = useWizardStore((state) => state.status)
  const deployStarted = useWizardStore((state) => state.deployStarted)
  const deployRunning = useWizardStore((state) => state.deployRunning)
  const setCurrentStep = useWizardStore((state) => state.setCurrentStep)
  const setStatus = useWizardStore((state) => state.setStatus)
  const loadFromEnvPayload = useWizardStore((state) => state.loadFromEnv)
  const [direction, setDirection] = useState(1)
  const [hydrated, setHydrated] = useState(false)
  const [expertOpen, setExpertOpen] = useState(false)
  const [updateState, setUpdateState] = useState<'idle' | 'pulling' | 'restarting' | 'error'>('idle')
  const [updateError, setUpdateError] = useState('')
  const reconnectingDeploymentIdRef = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const hydrate = async () => {
      await useWizardStore.persist.rehydrate()
      if (!active) return
      setHydrated(true)

      const [statusResult, envResult] = await Promise.allSettled([getStatus(), loadEnv()])
      if (!active) return

      if (statusResult.status === 'fulfilled') {
        setStatus(statusResult.value)
      }

      const latestState = useWizardStore.getState()
      if (envResult.status === 'fulfilled' && envResult.value.ok && envResult.value.data && isWizardDataPristine(latestState.data)) {
        loadFromEnvPayload(envResult.value.data)
      }
    }

    void hydrate()

    return () => {
      active = false
    }
  }, [loadFromEnvPayload, setStatus])

  useEffect(() => {
    if (!hydrated || !status) return
    if (!status.deploy_running && useWizardStore.getState().deployRunning) {
      useWizardStore.getState().setDeployState({ deployRunning: false })
    }
  }, [hydrated, status])

  useEffect(() => {
    if (!hydrated || !status?.deploy_running || !status.deploy_id) return
    if (reconnectingDeploymentIdRef.current === status.deploy_id) return

    const store = useWizardStore.getState()
    const sameDeployment = store.deployId === status.deploy_id
    const since = sameDeployment ? store.deployLastEventSeq : 0

    if (!sameDeployment) {
      store.resetDeploy()
      store.setDeployStages(initialDeployStages.map((stage) => ({ ...stage })))
      store.setDeployState({
        deployStarted: true,
        deployId: status.deploy_id,
        deployLastEventSeq: 0,
        deployRunning: true,
        deployProgress: 0,
        deployStepText: 'Reconnecting to deployment…',
        deploySummary: '',
        deployError: '',
      })
    } else {
      store.setDeployState({ deployStarted: true, deployRunning: true, deployId: status.deploy_id })
    }

    reconnectingDeploymentIdRef.current = status.deploy_id
    let cancelled = false

    void connectDeployEvents(status.deploy_id, since, (event) => {
      if (cancelled) return
      applyDeployEventToStore(event)
    })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Unable to reconnect to deployment status.'
        const currentStore = useWizardStore.getState()
        currentStore.appendDeployLog(`✗ ${message}`, 'err')
        currentStore.setDeployState({ deployRunning: false, deployError: message })
      })
      .finally(async () => {
        if (cancelled) return
        reconnectingDeploymentIdRef.current = null
        try {
          setStatus(await getStatus())
        } catch {
          // Ignore post-stream refresh failures.
        }
      })

    return () => {
      cancelled = true
    }
  }, [hydrated, setStatus, status?.deploy_id, status?.deploy_running])

  const handleSelfUpdate = async () => {
    setUpdateState('pulling')
    setUpdateError('')
    try {
      const result = await selfUpdate()
      if (!result.ok) {
        setUpdateError(result.error ?? 'Update failed')
        setUpdateState('error')
        return
      }
      // Server is restarting — poll /api/status until it responds, then reload
      setUpdateState('restarting')
      const poll = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            await getStatus()
            window.location.reload()
            return
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
        setUpdateError('Server did not come back in time — refresh manually.')
        setUpdateState('error')
      }
      void poll()
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Update failed')
      setUpdateState('error')
    }
  }

  const restoreEnabled = Boolean(data.RESTORE_ENABLED)

  const steps = useMemo(() => {
    const s = [...BASE_STEPS]
    if (restoreEnabled) {
      s.push({ title: 'Restore', icon: RotateCcw })
    }
    s.push({ title: 'Review & Deploy', shortTitle: 'Deploy', icon: Rocket })
    return s
  }, [restoreEnabled])

  const hasRestoreStep = restoreEnabled
  const deployStepIndex = steps.length - 1
  const restoreStepIndex = hasRestoreStep ? deployStepIndex - 1 : -1

  const canGoNext = useMemo(
    () => isStepValid(currentStep, data, nodes, localIpRanges, vpnOnly, hasRestoreStep),
    [currentStep, data, localIpRanges, nodes, vpnOnly, hasRestoreStep],
  )

  const nextLabel =
    currentStep === restoreStepIndex || (!hasRestoreStep && currentStep === 6)
      ? 'Review & deploy'
      : currentStep === 0
        ? 'Get started'
        : 'Continue'
  const showDeploymentBadge = Boolean(status?.env_saved || deployStarted)

  const goToStep = (nextStep: number) => {
    if (nextStep === currentStep) return
    setDirection(nextStep > currentStep ? 1 : -1)
    setCurrentStep(nextStep)
  }

  const handleNext = () => {
    if (!canGoNext || currentStep >= steps.length - 1) return
    goToStep(currentStep + 1)
  }

  const handlePrev = () => {
    if (currentStep === 0) return
    goToStep(currentStep - 1)
  }

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return <WelcomeStep onStart={() => goToStep(1)} onImportSuccess={() => goToStep(deployStepIndex)} />
      case 1:
        return <DomainStep />
      case 2:
        return <ProxmoxStep />
      case 3:
        return <ClusterStep />
      case 4:
        return <IdentityStep />
      case 5:
        return <CredentialsStep />
      case 6:
        return <FeaturesStep />
      case 7:
        return hasRestoreStep ? <RestoreStep /> : <DeployStep />
      case 8:
        return hasRestoreStep ? <DeployStep /> : null
      default:
        return null
    }
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--az-bg)] px-6">
        <div className="rounded-2xl border border-white/10 bg-white/5 px-6 py-4 text-sm text-[var(--az-text-secondary)] backdrop-blur-md">
          Restoring wizard state…
        </div>
      </div>
    )
  }

  return (
    <>
      <WizardShell
        steps={steps}
        currentStep={currentStep}
        direction={direction}
        canGoNext={canGoNext}
        nextLabel={nextLabel}
        hideFooter={currentStep === 0}
        hideNext={currentStep === steps.length - 1}
        onPrev={handlePrev}
        onNext={handleNext}
        onStepClick={(index) => index <= currentStep && goToStep(index)}
        headerActions={
          <div className="flex items-center gap-2">
            {updateState === 'error' ? (
              <span className="hidden max-w-[180px] truncate text-xs text-red-400 md:block" title={updateError}>{updateError}</span>
            ) : null}
            <ActionButton
              variant="secondary"
              onClick={() => void handleSelfUpdate()}
              disabled={updateState === 'pulling' || updateState === 'restarting'}
              className="px-3 py-2.5"
              title={updateState === 'restarting' ? 'Restarting server…' : updateState === 'pulling' ? 'Pulling latest…' : 'Pull latest from git and restart'}
            >
              <RefreshCw className={`h-4 w-4 ${updateState === 'pulling' || updateState === 'restarting' ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">
                {updateState === 'pulling' ? 'Pulling…' : updateState === 'restarting' ? 'Restarting…' : 'Update'}
              </span>
            </ActionButton>
            <ActionButton variant="secondary" onClick={() => setExpertOpen(true)} className="px-3 py-2.5">
              <Settings2 className="h-4 w-4" />
              <span className="hidden md:inline">Expert mode</span>
            </ActionButton>
          </div>
        }
      >
        {renderStep()}
      </WizardShell>
      {showDeploymentBadge ? (
        <div className="fixed bottom-6 right-6 z-50">
          <ActionButton variant={deployRunning ? 'primary' : 'secondary'} onClick={() => goToStep(7)} className="rounded-full px-5 py-3 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
            <BarChart3 className="h-4 w-4" />
            📊 Deployment
            <span className="hidden text-xs text-[var(--az-text-secondary)] md:inline">{deployRunning ? 'Live status' : status?.env_saved ? 'Saved .env ready' : 'Last known state'}</span>
          </ActionButton>
        </div>
      ) : null}
      <ExpertEnvModal open={expertOpen} onClose={() => setExpertOpen(false)} />
    </>
  )
}
