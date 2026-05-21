'use client'

import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  LoaderCircle,
  Lock,
  Server,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { discoverProxmox, setupProxmoxUser, validateProxmox } from '@/lib/api'
import { GlassCard } from '@/components/ui/GlassCard'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, fadeUpItem, isIPv4, staggerContainer } from '@/lib/utils'

type PveMode = 'setup' | 'manual'

function Meter({ label, used, available, unit }: { label: string; used: number; available: number; unit: string }) {
  const pct = available > 0 ? Math.min((used / available) * 100, 100) : 0
  const warn = available > 0 && used / available > 0.8
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--az-text-secondary)]">
        <span>{label}</span>
        <span>
          {used.toFixed(1)} / {available.toFixed(1)} {unit}
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full border border-white/8 bg-black/25">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${warn ? 'bg-[linear-gradient(90deg,#D47500,#f0c96b)]' : 'bg-[linear-gradient(90deg,#0078D4,#3ea6ff)]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function ProxmoxStep() {
  const data = useWizardStore((state) => state.data)
  const nodes = useWizardStore((state) => state.nodes)
  const status = useWizardStore((state) => state.status)
  const loading = useWizardStore((state) => state.loading)
  const proxmoxDiscovery = useWizardStore((state) => state.proxmoxDiscovery)
  const proxmoxValidation = useWizardStore((state) => state.proxmoxValidation)
  const setField = useWizardStore((state) => state.setField)
  const setFields = useWizardStore((state) => state.setFields)
  const setStatus = useWizardStore((state) => state.setStatus)
  const setLoading = useWizardStore((state) => state.setLoading)
  const setProxmoxDiscovery = useWizardStore((state) => state.setProxmoxDiscovery)
  const setProxmoxValidation = useWizardStore((state) => state.setProxmoxValidation)
  const getEnvPayload = useWizardStore((state) => state.getEnvPayload)
  const updateNode = useWizardStore((state) => state.updateNode)

  const [pveMode, setPveMode] = useState<PveMode>('setup')
  const [showToken, setShowToken] = useState(false)
  const [adminUser, setAdminUser] = useState('root@pam')
  const [adminPass, setAdminPass] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [setupResult, setSetupResult] = useState<{ ok: boolean; message: string } | null>(null)

  const totalClusterRamGb = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.memory || 0), 0) / 1024,
    [nodes],
  )
  const totalClusterDiskGb = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.disk || 0), 0),
    [nodes],
  )

  const applyHealthyStatus = (healthy: boolean) => {
    setStatus({
      ...(status ?? {
        env_saved: false,
        ssh_key: false,
        domain: false,
        dns_provider: 'none',
        dns_provider_configured: false,
        deploy_running: false,
        proxmox: false,
      }),
      proxmox: healthy,
    })
  }

  const handleSetupUser = async () => {
    const host = data.PROXMOX_HOST.trim()
    if (!host) {
      setSetupResult({ ok: false, message: 'Enter Proxmox host / IP first' })
      return
    }
    if (!adminUser.trim()) {
      setSetupResult({ ok: false, message: 'Enter admin username' })
      return
    }
    if (!adminPass) {
      setSetupResult({ ok: false, message: 'Enter admin password' })
      return
    }
    setLoading('setupProxmoxUser', true)
    setSetupResult(null)
    try {
      const result = await setupProxmoxUser(host, adminUser.trim(), adminPass)
      if (result.ok && result.token) {
        setField('PROXMOX_API_TOKEN', result.token)
        setSetupResult({ ok: true, message: '✅ infraweaver@pve created. Token auto-filled — credentials not stored.' })
        setAdminPass('')
        applyHealthyStatus(true)
      } else {
        setSetupResult({ ok: false, message: result.error ?? 'Setup failed' })
      }
    } finally {
      setLoading('setupProxmoxUser', false)
    }
  }

  const handleDiscover = useCallback(async (host: string, token: string) => {
    if (!host || !token) return
    setLoading('discoverProxmox', true)
    try {
      const result = await discoverProxmox(host, token)
      setProxmoxDiscovery(result)
      if (result.ok) {
        const firstNode = result.all_nodes?.[0] ?? result.node_name ?? data.PROXMOX_NODE_NAME
        const firstDatastore = (() => {
          const raw = result.datastores_by_node?.[firstNode]?.[0] ?? result.datastores?.[0]
          if (!raw) return undefined
          return typeof raw === 'object' ? raw.name : raw
        })() ?? data.TALOS_DATASTORE
        setFields({ PROXMOX_NODE_NAME: firstNode, TALOS_DATASTORE: firstDatastore })
        const currentNodes = useWizardStore.getState().nodes
        currentNodes.forEach((node, index) => {
          const rawDs = result.datastores_by_node?.[firstNode]?.[0] ?? firstDatastore
          const nodeDs = rawDs && typeof rawDs === 'object' ? rawDs.name : rawDs
          updateNode(node.id, {
            pveNode: firstNode,
            datastore: nodeDs,
            vmid: result.vmid_suggestions?.[index]?.toString() ?? node.vmid,
          })
        })
        applyHealthyStatus(true)
      }
    } finally {
      setLoading('discoverProxmox', false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-discover as soon as host + token are both valid — debounced 800 ms
  const autoDiscoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const host = data.PROXMOX_HOST.trim()
    const token = data.PROXMOX_API_TOKEN.trim()
    if (!isIPv4(host) || !token) return
    if (autoDiscoverTimer.current) clearTimeout(autoDiscoverTimer.current)
    autoDiscoverTimer.current = setTimeout(() => void handleDiscover(host, token), 800)
    return () => {
      if (autoDiscoverTimer.current) clearTimeout(autoDiscoverTimer.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.PROXMOX_HOST, data.PROXMOX_API_TOKEN])

  const handleValidate = async () => {
    if (!data.PROXMOX_API_TOKEN.trim()) return
    setLoading('validateProxmox', true)
    try {
      const result = await validateProxmox(getEnvPayload())
      setProxmoxValidation(result)
      applyHealthyStatus(Boolean(result.ok))
    } finally {
      setLoading('validateProxmox', false)
    }
  }

  const tabBase = 'flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition-all'
  const tabActive = `${tabBase} bg-white/10 text-white shadow-sm`
  const tabInactive = `${tabBase} text-[var(--az-text-secondary)] hover:text-white hover:bg-white/5`

  const availableRamGb = (proxmoxDiscovery?.node_memory_free_mb ?? 0) / 1024
  const availableDiskGb = proxmoxDiscovery?.node_disk_free_gb ?? 0
  const resourceWarn =
    (availableRamGb > 0 && totalClusterRamGb / availableRamGb > 0.8) ||
    (availableDiskGb > 0 && totalClusterDiskGb / availableDiskGb > 0.8)

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Server}
        eyebrow="Step 3 of 8"
        title="Proxmox connectivity and discovery"
        description="Connect to your Proxmox VE cluster. Use auto-setup to create a dedicated API user from root credentials, or enter an existing API token directly."
      />

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <GlassCard className="p-6 md:p-8">
          <FormField
            label="PROXMOX_HOST"
            htmlFor="PROXMOX_HOST"
            required
            error={data.PROXMOX_HOST && !isIPv4(data.PROXMOX_HOST) ? 'Use an IPv4 address for the Proxmox API host.' : undefined}
            hint="Proxmox management IP or DNS name used for API and SSH access."
          >
            <input
              id="PROXMOX_HOST"
              value={data.PROXMOX_HOST}
              onChange={(event) => setField('PROXMOX_HOST', event.target.value)}
              placeholder="192.168.1.100"
              className={controlClassName}
            />
          </FormField>

          <FormField className="mt-6" label="PROXMOX_NODE_NAME" htmlFor="PROXMOX_NODE_NAME" hint="Global default Proxmox node used for new VM placements.">
            <input
              id="PROXMOX_NODE_NAME"
              value={data.PROXMOX_NODE_NAME}
              onChange={(event) => setField('PROXMOX_NODE_NAME', event.target.value)}
              placeholder="pve"
              className={controlClassName}
            />
          </FormField>

          <button
            type="button"
            onClick={() => setAdvancedOpen((current) => !current)}
            className="mt-5 flex items-center gap-1.5 text-xs text-[var(--az-text-secondary)] transition hover:text-white"
          >
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            ⚙ Advanced
          </button>

          {advancedOpen ? (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4">
              <FormField label="CLUSTER_LOCAL_DOMAIN" htmlFor="pve-cluster-local-domain" hint="Shared internal DNS suffix mirrored in cluster bootstrap settings.">
                <input
                  id="pve-cluster-local-domain"
                  value={data.CLUSTER_LOCAL_DOMAIN}
                  onChange={(event) => setField('CLUSTER_LOCAL_DOMAIN', event.target.value)}
                  placeholder="prod.local"
                  className={controlClassName}
                />
              </FormField>
            </motion.div>
          ) : null}

          <div className="mt-6 flex gap-2 rounded-2xl border border-white/8 bg-black/20 p-1.5">
            <button type="button" className={pveMode === 'setup' ? tabActive : tabInactive} onClick={() => setPveMode('setup')}>
              <span className="mr-1.5">✨</span>Auto-setup
            </button>
            <button type="button" className={pveMode === 'manual' ? tabActive : tabInactive} onClick={() => setPveMode('manual')}>
              <span className="mr-1.5">🔑</span>I already have a token
            </button>
          </div>

          {pveMode === 'setup' ? (
            <motion.div key="setup" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6 space-y-4">
              <div className="flex items-start gap-3 rounded-2xl border border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.07)] p-4 text-sm text-[var(--az-text-secondary)]">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--az-success)]" />
                <span>
                  <strong className="text-white">Credentials are never stored.</strong> They are used once to create the <code className="text-white">infraweaver@pve</code> API user with minimal permissions. Only the resulting API token is saved.
                </span>
              </div>

              <FormField label="Admin username" htmlFor="pve-admin-user" hint="e.g. root@pam — must have User.Modify + Sys.Modify rights">
                <input
                  id="pve-admin-user"
                  value={adminUser}
                  onChange={(event) => setAdminUser(event.target.value)}
                  placeholder="root@pam"
                  className={controlClassName}
                  autoComplete="username"
                />
              </FormField>

              <FormField label="Admin password" htmlFor="pve-admin-pass">
                <div className="relative">
                  <input
                    id="pve-admin-pass"
                    type={showPass ? 'text' : 'password'}
                    value={adminPass}
                    onChange={(event) => setAdminPass(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleSetupUser()
                    }}
                    placeholder="••••••••"
                    className={`${controlClassName} pr-12`}
                    autoComplete="current-password"
                  />
                  <button type="button" onClick={() => setShowPass((current) => !current)} className="absolute inset-y-0 right-0 inline-flex w-12 items-center justify-center text-[var(--az-text-secondary)] hover:text-white">
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </FormField>

              <ActionButton variant="primary" onClick={handleSetupUser} disabled={loading.setupProxmoxUser} className="w-full justify-center">
                {loading.setupProxmoxUser ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Check access & create API user
              </ActionButton>

              {setupResult ? (
                <div className={`rounded-2xl border p-3 text-sm ${setupResult.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}>
                  {setupResult.message}
                </div>
              ) : null}

              {data.PROXMOX_API_TOKEN ? (
                <div className="rounded-2xl border border-white/8 bg-black/20 p-3 text-xs text-[var(--az-text-secondary)]">
                  <span className="font-medium text-[var(--az-success)]">Token ready:</span>{' '}
                  <code className="text-white">{data.PROXMOX_API_TOKEN.split('=')[0]}=…</code>
                </div>
              ) : null}
            </motion.div>
          ) : (
            <motion.div key="manual" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
              <FormField
                label="PROXMOX_API_TOKEN"
                htmlFor="PROXMOX_API_TOKEN"
                required
                hint={<>Format: <code>USER@pve!TOKENNAME=uuid</code>. Create in Datacenter → Permissions → API Tokens.</>}
              >
                <div className="relative">
                  <input
                    id="PROXMOX_API_TOKEN"
                    type={showToken ? 'text' : 'password'}
                    value={data.PROXMOX_API_TOKEN}
                    onChange={(event) => setField('PROXMOX_API_TOKEN', event.target.value)}
                    placeholder="infraweaver@pve!infraweaver=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className={`${controlClassName} pr-12`}
                  />
                  <button type="button" onClick={() => setShowToken((current) => !current)} className="absolute inset-y-0 right-0 inline-flex w-12 items-center justify-center text-[var(--az-text-secondary)] hover:text-white">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </FormField>
            </motion.div>
          )}

          <motion.div variants={fadeUpItem} className="mt-6 flex flex-wrap gap-3">
            <ActionButton variant="primary" onClick={() => void handleDiscover(data.PROXMOX_HOST.trim(), data.PROXMOX_API_TOKEN.trim())} disabled={loading.discoverProxmox || !data.PROXMOX_API_TOKEN}>
              {loading.discoverProxmox ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Waypoints className="h-4 w-4" />}
              🔍 Discover from Proxmox
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleValidate} disabled={loading.validateProxmox}>
              {loading.validateProxmox ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Validate API
            </ActionButton>
          </motion.div>
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium text-white">Discovery snapshot</div>
              <div className="text-xs text-[var(--az-text-secondary)]">Auto-fills node placement, storage, and VMIDs across the dynamic cluster builder.</div>
            </div>
          </motion.div>

          <div className="space-y-4">
            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">PVE nodes</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(proxmoxDiscovery?.all_nodes?.length ? proxmoxDiscovery.all_nodes : [data.PROXMOX_NODE_NAME || 'pve']).map((nodeName) => (
                  <span key={nodeName} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white">{nodeName}</span>
                ))}
              </div>
            </motion.div>

            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">Storage pools</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(proxmoxDiscovery?.datastores?.length ? proxmoxDiscovery.datastores : [data.TALOS_DATASTORE]).map((pool) => (
                  <span key={pool} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white">{pool}</span>
                ))}
              </div>
            </motion.div>

            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">VMID suggestions</div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {nodes.slice(0, 3).map((node, index) => (
                  <div key={node.id} className="rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-sm text-white">
                    Node {index + 1}: <span className="font-semibold">{node.vmid}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {proxmoxDiscovery?.ok && availableRamGb > 0 ? (
              <motion.div variants={fadeUpItem} className={`rounded-2xl border p-4 ${resourceWarn ? 'border-[rgba(212,117,0,0.3)] bg-[rgba(212,117,0,0.08)]' : 'border-white/8 bg-black/20'}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Resource meter</div>
                    <div className="mt-1 text-sm text-[var(--az-text-secondary)]">
                      Available on {proxmoxDiscovery.node_name ?? proxmoxDiscovery.all_nodes?.[0] ?? data.PROXMOX_NODE_NAME}: {availableRamGb.toFixed(1)} GB RAM / {availableDiskGb.toFixed(1)} GB disk
                    </div>
                    <div className="mt-1 text-sm text-[var(--az-text-secondary)]">
                      Your cluster needs: {totalClusterRamGb.toFixed(1)} GB RAM / {totalClusterDiskGb.toFixed(1)} GB disk
                    </div>
                  </div>
                  {resourceWarn ? <span className="rounded-full border border-[rgba(212,117,0,0.35)] bg-[rgba(212,117,0,0.12)] px-3 py-1 text-xs text-[var(--az-warning)]">Over 80% of available resources</span> : null}
                </div>
                <div className="mt-4 space-y-4">
                  <Meter label="RAM" used={totalClusterRamGb} available={availableRamGb} unit="GB" />
                  <Meter label="Disk" used={totalClusterDiskGb} available={availableDiskGb} unit="GB" />
                </div>
              </motion.div>
            ) : null}

            {proxmoxValidation ? (
              <motion.div variants={fadeUpItem} className={`rounded-2xl border p-4 text-sm ${proxmoxValidation.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}>
                {proxmoxValidation.ok ? `✅ Proxmox API reachable. Nodes: ${proxmoxValidation.nodes ?? 'available'}` : `✗ ${proxmoxValidation.error ?? 'Validation failed.'}`}
              </motion.div>
            ) : null}

            {proxmoxDiscovery ? (
              <motion.div variants={fadeUpItem} className={`rounded-2xl border p-4 text-sm ${proxmoxDiscovery.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}>
                {proxmoxDiscovery.ok ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Nodes: <strong>{proxmoxDiscovery.all_nodes?.join(', ') || proxmoxDiscovery.node_name}</strong> · Storage: <strong>{proxmoxDiscovery.datastores?.join(', ') || 'n/a'}</strong>
                    </span>
                  </div>
                ) : (
                  <span>✗ {proxmoxDiscovery.error ?? 'Unable to discover Proxmox details.'}</span>
                )}
              </motion.div>
            ) : null}
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
