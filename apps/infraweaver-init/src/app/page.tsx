'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Boxes,
  Globe,
  KeyRound,
  Rocket,
  Server,
  Settings2,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { WizardShell, type WizardStepMeta } from '@/components/WizardShell'
import { ClusterStep } from '@/components/steps/ClusterStep'
import { CredentialsStep } from '@/components/steps/CredentialsStep'
import { DeployStep } from '@/components/steps/DeployStep'
import { DomainStep } from '@/components/steps/DomainStep'
import { FeaturesStep } from '@/components/steps/FeaturesStep'
import { IdentityStep } from '@/components/steps/IdentityStep'
import { ProxmoxStep } from '@/components/steps/ProxmoxStep'
import { WelcomeStep } from '@/components/steps/WelcomeStep'
import { getStatus, loadEnv } from '@/lib/api'
import { initialWizardData, isWizardDataPristine, useWizardStore } from '@/lib/store'
import { isCIDR, isDomain, isEmail, isIPv4, isPositiveInteger } from '@/lib/utils'

const steps: Array<WizardStepMeta & { icon: React.ComponentType<{ className?: string }> }> = [
  { title: 'Welcome', icon: Sparkles },
  { title: 'Domain & Email', shortTitle: 'Domain', icon: Globe },
  { title: 'Proxmox', icon: Server },
  { title: 'Cluster Topology', shortTitle: 'Cluster', icon: Boxes },
  { title: 'Identity', icon: UserRound },
  { title: 'Credentials', icon: KeyRound },
  { title: 'Features', icon: Settings2 },
  { title: 'Review & Deploy', shortTitle: 'Deploy', icon: Rocket },
]

function isStepValid(step: number, data: typeof initialWizardData, localIpRanges: string[], vpnOnly: boolean) {
  switch (step) {
    case 0:
      return true
    case 1:
      return isDomain(data.BASE_DOMAIN) && isEmail(data.ADMIN_EMAIL)
    case 2:
      return isIPv4(data.PROXMOX_HOST) && data.PROXMOX_API_TOKEN.trim().length > 0
    case 3:
      return (
        data.PROXMOX_NODE_NAME.trim().length > 0 &&
        data.K8S_CLUSTER_NAME.trim().length > 0 &&
        data.TALOS_DATASTORE.trim().length > 0 &&
        isIPv4(data.NODE_GATEWAY) &&
        isPositiveInteger(data.NODE_SUBNET_PREFIX) &&
        isIPv4(data.NODE_1_IP) &&
        isIPv4(data.NODE_2_IP) &&
        isIPv4(data.NODE_3_IP) &&
        isPositiveInteger(data.NODE_1_VMID) &&
        isPositiveInteger(data.NODE_2_VMID) &&
        isPositiveInteger(data.NODE_3_VMID) &&
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
        data.CLOUDFLARE_API_TOKEN.trim().length > 0 &&
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
    default:
      return false
  }
}

export default function HomePage() {
  const currentStep = useWizardStore((state) => state.currentStep)
  const data = useWizardStore((state) => state.data)
  const localIpRanges = useWizardStore((state) => state.localIpRanges)
  const vpnOnly = useWizardStore((state) => state.vpnOnly)
  const setCurrentStep = useWizardStore((state) => state.setCurrentStep)
  const setStatus = useWizardStore((state) => state.setStatus)
  const loadFromEnvPayload = useWizardStore((state) => state.loadFromEnv)
  const [direction, setDirection] = useState(1)
  const [hydrated, setHydrated] = useState(false)

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

  const canGoNext = useMemo(() => isStepValid(currentStep, data, localIpRanges, vpnOnly), [currentStep, data, localIpRanges, vpnOnly])

  const nextLabel = currentStep === 6 ? 'Review & deploy' : currentStep === 0 ? 'Get started' : 'Continue'

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
        return <WelcomeStep onStart={() => goToStep(1)} />
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
        return <DeployStep />
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
    >
      {renderStep()}
    </WizardShell>
  )
}
