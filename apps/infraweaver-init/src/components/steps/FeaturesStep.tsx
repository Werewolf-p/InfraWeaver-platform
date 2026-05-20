'use client'

import { LoaderCircle, Plus, Settings2, Shield, Trash2, Wifi } from 'lucide-react'
import { motion } from 'framer-motion'
import { detectSubnet } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type BackupProvider } from '@/lib/store'
import { controlClassName, isCIDR, staggerContainer } from '@/lib/utils'

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/8 bg-black/20 p-4 md:flex-row md:items-center md:justify-between">
      <div>
        <div className="text-sm font-medium text-white">{title}</div>
        <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-[52px] rounded-full border transition ${checked ? 'border-[rgba(0,120,212,0.65)] bg-[rgba(0,120,212,0.3)]' : 'border-white/10 bg-white/8'}`}
      >
        <span
          className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-white transition ${checked ? 'left-[28px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  )
}

const backupOptions: Array<{ value: BackupProvider; title: string; copy: string }> = [
  { value: 'none', title: 'None', copy: 'No automated backups.' },
  { value: 'longhorn', title: 'Longhorn', copy: 'Block-level PVC backups to TrueNAS or NFS.' },
  { value: 'velero', title: 'Velero', copy: 'Cluster object backups plus snapshot orchestration.' },
  { value: 'both', title: 'Longhorn + Velero', copy: 'Highest coverage with the highest resource cost.' },
]

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

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Settings2}
        eyebrow="Step 7 of 8"
        title="Platform feature toggles"
        description="Choose which optional services ship with your cluster. You can enable mesh VPN, monitoring, external DNS sync (Cloudflare), and tune local-network access policies before the first deploy."
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_0.95fr]">
        <GlassCard className="p-6">
          <div className="space-y-4">
            <ToggleRow
              title="ENABLE_NETBIRD"
              description="Mesh VPN for secure remote access to internal services and operators."
              checked={data.ENABLE_NETBIRD}
              onChange={(next) => setField('ENABLE_NETBIRD', next)}
            />
            <ToggleRow
              title="ENABLE_MONITORING"
              description="Deploy Prometheus, Grafana, and Alertmanager for a full monitoring stack."
              checked={data.ENABLE_MONITORING}
              onChange={(next) => setField('ENABLE_MONITORING', next)}
            />
            <ToggleRow
              title="ENABLE_EXTERNAL_DNS"
              description="Synchronize ingress DNS records directly into Cloudflare. Requires Cloudflare as the DNS provider."
              checked={data.ENABLE_EXTERNAL_DNS}
              onChange={(next) => setField('ENABLE_EXTERNAL_DNS', next)}
            />
          </div>

          <div className="mt-6 rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">BACKUP_PROVIDER</div>
            <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">Choose how persistent data and cluster state are protected after bootstrap.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {backupOptions.map((option) => (
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
        </GlassCard>

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
      </div>
    </motion.div>
  )
}
