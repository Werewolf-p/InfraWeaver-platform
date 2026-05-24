'use client'

import { useMemo } from 'react'
import { LoaderCircle, Lock, Plus, Settings2, Shield, Trash2, Wifi } from 'lucide-react'
import { motion } from 'framer-motion'
import { detectSubnet } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type BackupProvider, type WizardData } from '@/lib/store'
import { controlClassName, isCIDR, staggerContainer } from '@/lib/utils'

interface CatalogApp {
  key: keyof WizardData | null
  slug: string
  name: string
  category: 'networking' | 'observability' | 'security' | 'storage' | 'dev' | 'core'
  description: string
  ramMb: number
  cpuM: number
  icon: string
  enabled: boolean
  required: boolean
  dependsOn?: string
}

const categoryLabels: Record<CatalogApp['category'], string> = {
  networking: 'Networking',
  observability: 'Observability',
  security: 'Security',
  storage: 'Storage',
  dev: 'Developer',
  core: 'Core',
}

const backupOptions: Array<{ value: BackupProvider; title: string; copy: string }> = [
  { value: 'none', title: 'None', copy: 'No automated backups.' },
  { value: 'longhorn', title: 'Longhorn', copy: 'Block-level PVC backups to TrueNAS or NFS.' },
  { value: 'velero', title: 'Velero', copy: 'Cluster object backups plus snapshot orchestration.' },
  { value: 'both', title: 'Longhorn + Velero', copy: 'Highest coverage with the highest resource cost.' },
]

function CatalogCard({ app, action }: { app: CatalogApp; action?: React.ReactNode }) {
  return (
    <div className={`rounded-2xl border p-4 ${app.required ? 'border-[rgba(87,163,0,0.2)] bg-[rgba(87,163,0,0.08)] opacity-80' : 'border-white/8 bg-black/20'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="text-3xl">{app.icon}</div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-white">{app.name}</div>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-[var(--az-text-secondary)]">
                {categoryLabels[app.category]}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-[var(--az-text-secondary)]">
                ~{app.ramMb} MB RAM
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">{app.description}</p>
          </div>
        </div>
        {action}
      </div>
    </div>
  )
}

export function FeaturesStep() {
  const data = useWizardStore((state) => state.data)
  const localIpRanges = useWizardStore((state) => state.localIpRanges)
  const vpnOnly = useWizardStore((state) => state.vpnOnly)
  const loading = useWizardStore((state) => state.loading)
  const setField = useWizardStore((state) => state.setField)
  const addLocalIpRange = useWizardStore((state) => state.addLocalIpRange)
  const updateLocalIpRange = useWizardStore((state) => state.updateLocalIpRange)
  const removeLocalIpRange = useWizardStore((state) => state.removeLocalIpRange)
  const setVpnOnly = useWizardStore((state) => state.setVpnOnly)
  const mergeDetectedSubnets = useWizardStore((state) => state.mergeDetectedSubnets)
  const setLoading = useWizardStore((state) => state.setLoading)

  const coreApps = useMemo<CatalogApp[]>(
    () => [
      { key: null, slug: 'argocd', name: 'ArgoCD', category: 'core', description: 'Core GitOps engine for syncing the platform.', ramMb: 512, cpuM: 300, icon: '🔄', enabled: true, required: true },
      { key: null, slug: 'openbao', name: 'OpenBao', category: 'security', description: 'Secrets vault used for local platform secret management.', ramMb: 256, cpuM: 200, icon: '🔐', enabled: true, required: true },
      { key: null, slug: 'external-secrets', name: 'External Secrets', category: 'security', description: 'Synchronizes secrets into workloads after bootstrap.', ramMb: 128, cpuM: 100, icon: '🔑', enabled: true, required: true },
      { key: null, slug: 'traefik', name: 'Traefik', category: 'networking', description: 'Ingress edge router for every service endpoint.', ramMb: 128, cpuM: 100, icon: '🔀', enabled: true, required: true },
      { key: null, slug: 'metallb', name: 'MetalLB', category: 'networking', description: 'Bare-metal load balancer for VIP allocation.', ramMb: 64, cpuM: 50, icon: '⚖️', enabled: true, required: true },
      { key: null, slug: 'cert-manager', name: 'cert-manager', category: 'security', description: 'Automates ACME and internal certificate issuance.', ramMb: 128, cpuM: 100, icon: '🔒', enabled: true, required: true },
      { key: null, slug: 'longhorn', name: 'Longhorn', category: 'storage', description: 'Distributed block storage for stateful platform apps.', ramMb: 512, cpuM: 300, icon: '💾', enabled: true, required: true },
      { key: null, slug: 'onedev', name: 'Onedev', category: 'dev', description: 'Local Git, CI, and delivery control plane.', ramMb: 1024, cpuM: 500, icon: '📦', enabled: true, required: true },
      { key: null, slug: 'authentik', name: 'Authentik', category: 'security', description: 'SSO and identity provider for the platform.', ramMb: 512, cpuM: 250, icon: '👤', enabled: true, required: true },
    ],
    [],
  )

  const optionalApps = useMemo<CatalogApp[]>(
    () => [
      { key: 'ENABLE_NETBIRD', slug: 'netbird', name: 'NetBird VPN', category: 'networking', description: 'Secure operator and service access over mesh VPN.', ramMb: 256, cpuM: 150, icon: '🌐', enabled: data.ENABLE_NETBIRD, required: false },
      { key: 'ENABLE_MONITORING', slug: 'monitoring', name: 'Grafana + monitoring stack', category: 'observability', description: 'Prometheus, Grafana, Alertmanager, and service monitors.', ramMb: 512, cpuM: 250, icon: '📊', enabled: data.ENABLE_MONITORING, required: false },
      { key: 'ENABLE_EXTERNAL_DNS', slug: 'external-dns', name: 'External DNS', category: 'networking', description: 'Writes ingress records to your DNS provider during sync.', ramMb: 64, cpuM: 50, icon: '🌍', enabled: data.ENABLE_EXTERNAL_DNS, required: false },
      { key: null, slug: 'backups', name: 'Backups', category: 'storage', description: 'Enable Longhorn, Velero, or both for backup workflows.', ramMb: 256, cpuM: 200, icon: '💾', enabled: data.BACKUP_PROVIDER !== 'none', required: false },
    ],
    [data.BACKUP_PROVIDER, data.ENABLE_EXTERNAL_DNS, data.ENABLE_MONITORING, data.ENABLE_NETBIRD],
  )

  const enabledOptionalRamMb = useMemo(
    () => optionalApps.filter((app) => app.enabled).reduce((sum, app) => sum + app.ramMb, 0),
    [optionalApps],
  )

  const handleDetectSubnets = async () => {
    setLoading('detectSubnets', true)
    try {
      const result = await detectSubnet()
      if (result.ok && result.subnets?.length) {
        mergeDetectedSubnets(result.subnets)
      }
    } finally {
      setLoading('detectSubnets', false)
    }
  }

  const toggleOptional = (app: CatalogApp) => {
    if (app.slug === 'backups') {
      setField('BACKUP_PROVIDER', app.enabled ? 'none' : 'longhorn')
      return
    }
    if (app.key) setField(app.key, !app.enabled as never)
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Settings2}
        eyebrow="Step 7 of 8"
        title="Feature catalog and access policy"
        description="Review the full platform catalog, enable optional services with clear resource budgets, and keep local-network access rules close to the feature plan."
      />

      <GlassCard className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)]">Optional feature budget</div>
            <div className="mt-2 text-2xl font-semibold text-white">{(enabledOptionalRamMb / 1024).toFixed(1)} GB RAM total for enabled optional features</div>
          </div>
          <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-[var(--az-text-secondary)]">
            {optionalApps.filter((app) => app.enabled).length} / {optionalApps.length} optional features enabled
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <GlassCard className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <Lock className="h-5 w-5 text-[var(--az-success)]" />
            <div>
              <div className="text-lg font-semibold text-white">✅ Core Platform (always installed)</div>
              <div className="text-sm text-[var(--az-text-secondary)]">These apps ship with every InfraWeaver cluster and are shown here for transparency.</div>
            </div>
          </div>

          <div className="space-y-4">
            {coreApps.map((app) => (
              <CatalogCard
                key={app.slug}
                app={app}
                action={<span className="inline-flex items-center gap-2 rounded-full border border-[rgba(87,163,0,0.3)] bg-[rgba(87,163,0,0.12)] px-3 py-1 text-xs text-[var(--az-success)]"><Lock className="h-3.5 w-3.5" /> Included</span>}
              />
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <div className="mb-5">
            <div className="text-lg font-semibold text-white">🎛️ Optional Features</div>
            <div className="mt-1 text-sm text-[var(--az-text-secondary)]">Turn add-ons on and off without leaving the catalog view.</div>
          </div>

          <div className="space-y-4">
            {optionalApps.map((app) => (
              <div key={app.slug} className="space-y-3">
                <CatalogCard
                  app={app}
                  action={
                    <ActionButton variant={app.enabled ? 'primary' : 'secondary'} onClick={() => toggleOptional(app)} className="min-w-24">
                      {app.enabled ? 'Enabled' : 'Enable'}
                    </ActionButton>
                  }
                />

                {app.slug === 'backups' && app.enabled ? (
                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <div className="text-sm font-medium text-white">Backup provider</div>
                    <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">Choose how persistent data and cluster state are protected after bootstrap.</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {backupOptions.filter((option) => option.value !== 'none').map((option) => (
                        <label
                          key={option.value}
                          className={`cursor-pointer rounded-2xl border p-4 transition ${data.BACKUP_PROVIDER === option.value ? 'border-[rgba(0,120,212,0.5)] bg-[rgba(0,120,212,0.12)]' : 'border-white/10 bg-white/5 hover:border-white/20'}`}
                        >
                          <input
                            type="radio"
                            name="backup-provider"
                            checked={data.BACKUP_PROVIDER === option.value}
                            onChange={() => setField('BACKUP_PROVIDER', option.value)}
                            className="sr-only"
                          />
                          <div className="text-sm font-medium text-white">{option.title}</div>
                          <div className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">{option.copy}</div>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      <GlassCard className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-white">
              <Wifi className="h-5 w-5 text-[var(--az-primary)]" />
              Local network access
            </div>
            <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">Define LAN CIDR ranges that may access internal services. System and cluster ranges are still appended automatically at deploy time.</p>
          </div>
          <ActionButton variant="secondary" onClick={handleDetectSubnets} disabled={loading.detectSubnets}>
            {loading.detectSubnets ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            🔍 Auto-detect
          </ActionButton>
        </div>

        <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-white">VPN-only mode</div>
              <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">Require NetBird for all internal services and disable direct LAN access.</p>
            </div>
            <button
              type="button"
              onClick={() => setVpnOnly(!vpnOnly)}
              className={`relative h-7 w-[52px] rounded-full border transition ${vpnOnly ? 'border-[rgba(0,120,212,0.65)] bg-[rgba(0,120,212,0.3)]' : 'border-white/10 bg-white/8'}`}
            >
              <span className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-white transition ${vpnOnly ? 'left-[28px]' : 'left-0.5'}`} />
            </button>
          </div>
        </div>

        <div className={`mt-4 space-y-3 transition ${vpnOnly ? 'pointer-events-none opacity-40' : 'opacity-100'}`}>
          {localIpRanges.map((range, index) => (
            <div key={`${index}-${range}`} className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-3">
              <div className="flex-1">
                <input
                  value={range}
                  onChange={(event) => updateLocalIpRange(index, event.target.value)}
                  placeholder="192.168.1.0/24"
                  className={controlClassName}
                />
                {range && !isCIDR(range) ? <p className="mt-2 text-xs text-[var(--az-danger)]">Enter a valid CIDR range such as 192.168.1.0/24.</p> : null}
              </div>
              <ActionButton variant="ghost" onClick={() => removeLocalIpRange(index)} className="mt-1 px-3 py-3">
                <Trash2 className="h-4 w-4" />
              </ActionButton>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <ActionButton variant="secondary" onClick={addLocalIpRange} disabled={vpnOnly}>
            <Plus className="h-4 w-4" />
            Add range
          </ActionButton>
        </div>
      </GlassCard>

      <GlassCard className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-white">
              <RefreshCw className="h-5 w-5 text-[var(--az-primary)]" />
              Restore previous deployment
            </div>
            <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">
              Restore application data and TLS certificates from TrueNAS NFS backups before services start. Adds a
              dedicated restore step before deploy where you select exactly what to bring back.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setField('RESTORE_ENABLED', !data.RESTORE_ENABLED)}
            className={`relative h-7 w-[52px] rounded-full border transition ${
              data.RESTORE_ENABLED
                ? 'border-[rgba(0,120,212,0.65)] bg-[rgba(0,120,212,0.3)]'
                : 'border-white/10 bg-white/8'
            }`}
          >
            <span
              className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-white transition ${
                data.RESTORE_ENABLED ? 'left-[28px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
        {data.RESTORE_ENABLED && (
          <div className="mt-4 rounded-2xl border border-[rgba(0,120,212,0.3)] bg-[rgba(0,120,212,0.08)] p-4">
            <p className="text-sm text-[var(--az-primary)]">
              ✅ A <strong>Restore</strong> step will appear before <strong>Review &amp; Deploy</strong> — you can select
              which data volumes and TLS certs to restore.
            </p>
          </div>
        )}
      </GlassCard>
    </motion.div>
  )
}
