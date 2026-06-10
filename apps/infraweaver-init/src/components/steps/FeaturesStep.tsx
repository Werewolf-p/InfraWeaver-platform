'use client'

import { useMemo } from 'react'
import { LoaderCircle, Lock, Plus, RefreshCw, Settings2, Shield, Trash2, Wifi } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { detectSubnet } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type BackupProvider, type MonitoringStack, type WizardData } from '@/lib/store'
import { controlClassName, isCIDR, staggerContainer } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoreApp {
  slug: string
  name: string
  icon: string
  category: string
  description: string
  ramMb: number
}

interface OptionalFeature {
  key: keyof WizardData
  slug: string
  name: string
  icon: string
  category: 'networking' | 'observability' | 'security' | 'storage'
  description: string
  without: string
  ramMb: number
  defaultOn: boolean
}

// ── Static data ───────────────────────────────────────────────────────────────

const CORE_APPS: CoreApp[] = [
  { slug: 'argocd',           name: 'ArgoCD',           icon: '🔄', category: 'Core',       description: 'GitOps engine that syncs the entire platform from Git.',                   ramMb: 512  },
  { slug: 'authentik',        name: 'Authentik',        icon: '👤', category: 'Security',   description: 'SSO and OIDC identity provider for every app login.',                     ramMb: 512  },
  { slug: 'openbao',          name: 'OpenBao',          icon: '🔐', category: 'Security',   description: 'Secrets vault — stores all credentials and tokens.',                      ramMb: 256  },
  { slug: 'external-secrets', name: 'External Secrets', icon: '🔑', category: 'Security',   description: 'Pulls secrets from OpenBao into Kubernetes.',                             ramMb: 128  },
  { slug: 'traefik',          name: 'Traefik',          icon: '🔀', category: 'Networking', description: 'Ingress edge router — routes all HTTP/S traffic to services.',            ramMb: 128  },
  { slug: 'metallb',          name: 'MetalLB',          icon: '⚖️', category: 'Networking', description: 'Assigns LoadBalancer IPs on bare metal.',                                 ramMb: 64   },
  { slug: 'cert-manager',     name: 'cert-manager',     icon: '🔒', category: 'Security',   description: 'Automates TLS certificate issuance via Let\'s Encrypt.',                 ramMb: 128  },
  { slug: 'onedev',           name: 'OneDev',           icon: '📦', category: 'Dev',        description: 'Self-hosted Git, CI/CD, and issue tracker.',                              ramMb: 1024 },
]

const OPTIONAL_FEATURES: OptionalFeature[] = [
  // Storage
  { key: 'ENABLE_LONGHORN',       slug: 'longhorn',        name: 'Longhorn',              icon: '💾', category: 'storage',      description: 'Distributed HA block storage — replicates PVCs across nodes and backs up to NFS nightly.', without: 'No cross-node storage replication or scheduled backups. Local-path only.', ramMb: 512,  defaultOn: true  },
  // Security
  { key: 'ENABLE_KYVERNO',        slug: 'kyverno',         name: 'Kyverno',               icon: '🛡️', category: 'security',     description: 'Kubernetes policy engine — enforces resource limits and blocks privileged containers.', without: 'PSA namespace labels remain but no custom policy enforcement.', ramMb: 480,  defaultOn: true  },
  { key: 'ENABLE_AUTHENTIK_LDAP', slug: 'ldap-outpost',    name: 'Authentik LDAP Outpost',icon: '📂', category: 'security',     description: 'Makes Authentik serve as an LDAP directory for apps that can\'t use OIDC (e.g. TrueNAS).', without: 'TrueNAS and legacy LDAP-only apps cannot authenticate.', ramMb: 256,  defaultOn: false },
  { key: 'ENABLE_WAZUH',          slug: 'wazuh',           name: 'Wazuh SIEM',            icon: '🚨', category: 'security',     description: 'Full SIEM platform — security event collection, intrusion detection, compliance reporting.', without: 'No centralized security event monitoring.', ramMb: 4000, defaultOn: false },
  // Observability
  { key: 'ENABLE_MONITORING',     slug: 'monitoring',      name: 'Prometheus Monitoring', icon: '📊', category: 'observability', description: 'Prometheus + Alertmanager + kube-state-metrics — powers the console metrics dashboard.', without: 'Console metrics and alert tabs will show as unavailable.', ramMb: 700,  defaultOn: true  },
  { key: 'ENABLE_LOKI',           slug: 'loki',            name: 'Loki Log Aggregation',  icon: '📋', category: 'observability', description: 'Collects and stores pod logs for the console log-analytics tab.', without: 'Console log tab unavailable. kubectl logs still work.', ramMb: 1000, defaultOn: true  },
  { key: 'ENABLE_GRAFANA',        slug: 'grafana',         name: 'Standalone Grafana',    icon: '📈', category: 'observability', description: 'Grafana with pre-built dashboards for custom metric visualisation.', without: 'Console has its own charts — Grafana is purely for custom dashboards.', ramMb: 512,  defaultOn: false },
  // Networking
  { key: 'ENABLE_EXTERNAL_DNS',   slug: 'external-dns',    name: 'External DNS',          icon: '🌍', category: 'networking',   description: 'Auto-creates DNS records in Cloudflare/Route53 when ingresses are created.', without: 'DNS records must be created manually.', ramMb: 64,   defaultOn: false },
]

const CATEGORY_ORDER: OptionalFeature['category'][] = ['storage', 'security', 'observability', 'networking']
const CATEGORY_LABELS: Record<OptionalFeature['category'], string> = {
  storage:      '💾 Storage',
  security:     '🛡️ Security',
  observability:'📊 Observability',
  networking:   '🌐 Networking',
}

const CORE_RAM_MB = CORE_APPS.reduce((sum, app) => sum + app.ramMb, 0)
// Rough k8s overhead (kubelet, kube-proxy, coredns, etc.)
const K8S_OVERHEAD_MB = 768
const TOTAL_FIXED_MB = CORE_RAM_MB + K8S_OVERHEAD_MB

const backupOptions: Array<{ value: BackupProvider; title: string; ramMb: number; copy: string }> = [
  { value: 'none',    title: 'None',             ramMb: 0,   copy: 'No automated backups.' },
  { value: 'longhorn',title: 'Longhorn',         ramMb: 0,   copy: 'Block-level PVC backup to TrueNAS/NFS — included in Longhorn above.' },
  { value: 'velero',  title: 'Velero',           ramMb: 256, copy: 'Kubernetes object backup to MinIO S3 — captures cluster state.' },
  { value: 'both',    title: 'Longhorn + Velero', ramMb: 256, copy: 'Maximum coverage: block-level data + full cluster state.' },
]

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-checked={checked}
      role="switch"
      className={`relative h-7 w-[52px] shrink-0 rounded-full border transition-all duration-200 ${
        checked ? 'border-[rgba(0,120,212,0.65)] bg-[rgba(0,120,212,0.3)]' : 'border-white/10 bg-white/8'
      }`}
    >
      <span
        className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-white shadow-sm transition-all duration-200 ${
          checked ? 'left-[28px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function RamPill({ mb, dim }: { mb: number; dim?: boolean }) {
  const label = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-opacity ${dim ? 'border-white/5 text-white/20 opacity-50' : 'border-white/10 bg-white/5 text-[var(--az-text-secondary)]'}`}>
      ~{label}
    </span>
  )
}

// ── RAM Meter ────────────────────────────────────────────────────────────────

function RamMeter({ totalMb, optionalMb, breakdown }: { totalMb: number; optionalMb: number; breakdown: Array<{ name: string; mb: number; color: string }> }) {
  const ceilingMb = Math.max(totalMb * 1.15, 32768) // show at least 32 GB ceiling
  const fixedPct  = (TOTAL_FIXED_MB / ceilingMb) * 100
  const optPct    = (optionalMb      / ceilingMb) * 100

  const color = totalMb < 10240 ? 'var(--az-success)' : totalMb < 18432 ? '#f59e0b' : '#ef4444'
  const colorClass = totalMb < 10240 ? 'text-[var(--az-success)]' : totalMb < 18432 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)]">Expected RAM usage</div>
          <div className={`mt-1 text-3xl font-semibold tabular-nums transition-colors ${colorClass}`}>
            {(totalMb / 1024).toFixed(1)} GB
          </div>
          <div className="mt-1 text-sm text-[var(--az-text-secondary)]">
            {(TOTAL_FIXED_MB / 1024).toFixed(1)} GB core &nbsp;+&nbsp; {(optionalMb / 1024).toFixed(1)} GB optional
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
            Core (fixed)  {(TOTAL_FIXED_MB / 1024).toFixed(1)} GB
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
            Optional  {(optionalMb / 1024).toFixed(1)} GB
          </span>
        </div>
      </div>

      {/* Bar */}
      <div className="h-4 w-full overflow-hidden rounded-full bg-white/5">
        <div className="flex h-full">
          <motion.div
            className="h-full rounded-l-full bg-white/20"
            animate={{ width: `${fixedPct}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
          <motion.div
            className="h-full"
            style={{ backgroundColor: color, opacity: 0.7 }}
            animate={{ width: `${optPct}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </div>
      </div>

      {/* Breakdown chips */}
      <div className="flex flex-wrap gap-2">
        {breakdown.map((item) => (
          <span key={item.name} className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/5 px-2.5 py-1 text-[11px] text-[var(--az-text-secondary)]">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name} {item.mb >= 1024 ? `${(item.mb / 1024).toFixed(1)}GB` : `${item.mb}MB`}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function FeaturesStep() {
  const data             = useWizardStore((state) => state.data)
  const localIpRanges    = useWizardStore((state) => state.localIpRanges)
  const loading          = useWizardStore((state) => state.loading)
  const setField         = useWizardStore((state) => state.setField)
  const addLocalIpRange  = useWizardStore((state) => state.addLocalIpRange)
  const updateLocalIpRange = useWizardStore((state) => state.updateLocalIpRange)
  const removeLocalIpRange = useWizardStore((state) => state.removeLocalIpRange)
  const mergeDetectedSubnets = useWizardStore((state) => state.mergeDetectedSubnets)
  const setLoading       = useWizardStore((state) => state.setLoading)

  // Compute RAM for each optional feature currently enabled
  const optionalRamMb = useMemo(() => {
    let total = 0
    for (const feat of OPTIONAL_FEATURES) {
      const enabled = Boolean(data[feat.key])
      if (!enabled) continue
      // Monitoring: swap RAM if using victoria-metrics
      if (feat.slug === 'monitoring' && data.MONITORING_STACK === 'victoria-metrics') {
        total += 320
      } else {
        total += feat.ramMb
      }
    }
    // Velero add-on
    const backupOpt = backupOptions.find((b) => b.value === data.BACKUP_PROVIDER)
    if (backupOpt) total += backupOpt.ramMb
    return total
  }, [data])

  const totalRamMb = TOTAL_FIXED_MB + optionalRamMb

  // Build breakdown chips for meter
  const breakdown = useMemo(() => {
    const chips: Array<{ name: string; mb: number; color: string }> = [
      { name: 'Core', mb: TOTAL_FIXED_MB, color: 'rgba(255,255,255,0.3)' },
    ]
    const optColors: Record<OptionalFeature['category'], string> = {
      storage: '#10b981', security: '#8b5cf6', observability: '#0078d4', networking: '#f59e0b',
    }
    for (const feat of OPTIONAL_FEATURES) {
      if (!data[feat.key]) continue
      const mb = feat.slug === 'monitoring' && data.MONITORING_STACK === 'victoria-metrics' ? 320 : feat.ramMb
      chips.push({ name: feat.name.split(' ')[0], mb, color: optColors[feat.category] })
    }
    const backupOpt = backupOptions.find((b) => b.value === data.BACKUP_PROVIDER)
    if (backupOpt && backupOpt.ramMb > 0) chips.push({ name: 'Velero', mb: backupOpt.ramMb, color: '#10b981' })
    return chips
  }, [data])

  const groupedFeatures = useMemo(() =>
    CATEGORY_ORDER.map((cat) => ({
      category: cat,
      features: OPTIONAL_FEATURES.filter((f) => f.category === cat),
    })),
    [],
  )

  const handleDetectSubnets = async () => {
    setLoading('detectSubnets', true)
    try {
      const result = await detectSubnet()
      if (result.ok && result.subnets?.length) mergeDetectedSubnets(result.subnets)
    } finally {
      setLoading('detectSubnets', false)
    }
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Settings2}
        eyebrow="Step 7 of 8"
        title="Feature catalog and resource budget"
        description="Toggle optional features and see your expected RAM usage update in real time. Core platform apps are always installed."
      />

      {/* ── RAM Budget Meter ── */}
      <GlassCard className="p-6">
        <RamMeter totalMb={totalRamMb} optionalMb={optionalRamMb} breakdown={breakdown} />
      </GlassCard>

      {/* ── Core + Optional side by side ── */}
      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">

        {/* Core apps — always on */}
        <GlassCard className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <Lock className="h-5 w-5 text-[var(--az-success)]" />
            <div>
              <div className="text-base font-semibold text-white">Core Platform</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Always installed — these cannot be disabled.</div>
            </div>
          </div>
          <div className="space-y-3">
            {CORE_APPS.map((app) => (
              <div key={app.slug} className="flex items-center justify-between gap-4 rounded-2xl border border-[rgba(87,163,0,0.15)] bg-[rgba(87,163,0,0.06)] px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xl">{app.icon}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{app.name}</div>
                    <div className="truncate text-xs text-[var(--az-text-secondary)]">{app.description}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RamPill mb={app.ramMb} />
                  <span className="rounded-full border border-[rgba(87,163,0,0.35)] bg-[rgba(87,163,0,0.12)] px-2.5 py-1 text-[11px] text-[var(--az-success)]">Included</span>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* Optional features */}
        <GlassCard className="p-6">
          <div className="mb-5">
            <div className="text-base font-semibold text-white">Optional Features</div>
            <div className="mt-1 text-sm text-[var(--az-text-secondary)]">Toggle on/off — RAM budget updates instantly.</div>
          </div>

          <div className="space-y-6">
            {groupedFeatures.map(({ category, features }) => (
              <div key={category}>
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--az-text-secondary)]">
                  {CATEGORY_LABELS[category]}
                </div>
                <div className="space-y-3">
                  {features.map((feat) => {
                    const enabled = Boolean(data[feat.key])
                    return (
                      <div key={feat.slug} className="space-y-0">
                        <div className={`rounded-2xl border p-4 transition-all duration-200 ${enabled ? 'border-[rgba(0,120,212,0.3)] bg-[rgba(0,120,212,0.08)]' : 'border-white/8 bg-black/20'}`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3 min-w-0">
                              <span className="mt-0.5 text-xl">{feat.icon}</span>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium text-white">{feat.name}</span>
                                  <RamPill mb={feat.slug === 'monitoring' && data.MONITORING_STACK === 'victoria-metrics' ? 320 : feat.ramMb} dim={!enabled} />
                                </div>
                                <p className="mt-1.5 text-xs leading-5 text-[var(--az-text-secondary)]">{feat.description}</p>
                                <AnimatePresence>
                                  {!enabled && (
                                    <motion.p
                                      initial={{ opacity: 0, height: 0, marginTop: 0 }}
                                      animate={{ opacity: 1, height: 'auto', marginTop: 4 }}
                                      exit={{ opacity: 0, height: 0, marginTop: 0 }}
                                      transition={{ duration: 0.18 }}
                                      className="overflow-hidden text-xs text-amber-400/70"
                                    >
                                      ⚠️ {feat.without}
                                    </motion.p>
                                  )}
                                </AnimatePresence>
                              </div>
                            </div>
                            <Toggle checked={enabled} onChange={() => setField(feat.key, !enabled as never)} />
                          </div>

                          {/* Monitoring stack picker */}
                          <AnimatePresence>
                            {feat.slug === 'monitoring' && enabled && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <div className="mt-4 grid grid-cols-2 gap-2">
                                  {([ ['kube-prometheus-stack', '🏋️', 'Prometheus Stack', '700 MB', 'Full-featured: Prometheus + kube-state-metrics + node-exporter'], ['victoria-metrics', '🪶', 'VictoriaMetrics', '320 MB', 'Lightweight drop-in replacement, PromQL compatible'] ] as const).map(([val, icon, label, ram, desc]) => (
                                    <label key={val} className={`cursor-pointer rounded-xl border p-3 transition ${data.MONITORING_STACK === val ? 'border-[rgba(0,120,212,0.5)] bg-[rgba(0,120,212,0.12)]' : 'border-white/10 bg-white/5 hover:border-white/20'}`}>
                                      <input type="radio" className="sr-only" name="monitoring-stack" checked={data.MONITORING_STACK === val} onChange={() => setField('MONITORING_STACK', val as MonitoringStack)} />
                                      <div className="flex items-center gap-2">
                                        <span className="text-base">{icon}</span>
                                        <span className="text-xs font-semibold text-white">{label}</span>
                                        <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-[var(--az-text-secondary)]">{ram}</span>
                                      </div>
                                      <p className="mt-1.5 text-[11px] leading-4 text-[var(--az-text-secondary)]">{desc}</p>
                                    </label>
                                  ))}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* ── Backup provider ── */}
      <GlassCard className="p-6">
        <div className="mb-4 text-base font-semibold text-white">💾 Backup Provider</div>
        <p className="mb-4 text-sm leading-6 text-[var(--az-text-secondary)]">Choose how persistent data and cluster state are protected. Longhorn NFS backup is configured via <code className="rounded bg-white/8 px-1 text-xs">persistence.truenas</code> in platform.yaml.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {backupOptions.map((option) => (
            <label key={option.value} className={`cursor-pointer rounded-2xl border p-4 transition ${data.BACKUP_PROVIDER === option.value ? 'border-[rgba(0,120,212,0.5)] bg-[rgba(0,120,212,0.12)]' : 'border-white/10 bg-white/5 hover:border-white/20'}`}>
              <input type="radio" name="backup-provider" className="sr-only" checked={data.BACKUP_PROVIDER === option.value} onChange={() => setField('BACKUP_PROVIDER', option.value)} />
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-white">{option.title}</div>
                {option.ramMb > 0 && <RamPill mb={option.ramMb} />}
              </div>
              <div className="mt-2 text-xs leading-5 text-[var(--az-text-secondary)]">{option.copy}</div>
            </label>
          ))}
        </div>
      </GlassCard>

      {/* ── Local network access ── */}
      <GlassCard className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <Wifi className="h-5 w-5 text-[var(--az-primary)]" />
              Local network access
            </div>
            <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">Define LAN CIDR ranges that may access internal services. System and cluster ranges are appended automatically.</p>
          </div>
          <ActionButton variant="secondary" onClick={handleDetectSubnets} disabled={loading.detectSubnets}>
            {loading.detectSubnets ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            Auto-detect
          </ActionButton>
        </div>

        <div className="mt-4 space-y-3">
          {localIpRanges.map((range, index) => (
            <div key={`${index}-${range}`} className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-3">
              <div className="flex-1">
                <input value={range} onChange={(event) => updateLocalIpRange(index, event.target.value)} placeholder="192.168.1.0/24" className={controlClassName} />
                {range && !isCIDR(range) ? <p className="mt-2 text-xs text-[var(--az-danger)]">Enter a valid CIDR range such as 192.168.1.0/24.</p> : null}
              </div>
              <ActionButton variant="ghost" onClick={() => removeLocalIpRange(index)} className="mt-1 px-3 py-3">
                <Trash2 className="h-4 w-4" />
              </ActionButton>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <ActionButton variant="secondary" onClick={addLocalIpRange}>
            <Plus className="h-4 w-4" />
            Add range
          </ActionButton>
        </div>
      </GlassCard>

      {/* ── Restore ── */}
      <GlassCard className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <RefreshCw className="h-5 w-5 text-[var(--az-primary)]" />
              Restore previous deployment
            </div>
            <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">
              Restore application data and TLS certificates from TrueNAS NFS backups before services start.
            </p>
          </div>
          <Toggle checked={Boolean(data.RESTORE_ENABLED)} onChange={() => setField('RESTORE_ENABLED', !data.RESTORE_ENABLED)} />
        </div>
        <AnimatePresence>
          {data.RESTORE_ENABLED && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="mt-4 rounded-2xl border border-[rgba(0,120,212,0.3)] bg-[rgba(0,120,212,0.08)] p-4">
                <p className="text-sm text-[var(--az-primary)]">
                  ✅ A <strong>Restore</strong> step will appear before <strong>Review &amp; Deploy</strong> — select which volumes and TLS certs to restore.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </GlassCard>
    </motion.div>
  )
}

