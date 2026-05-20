'use client'

import { useState } from 'react'
import { CheckCircle2, Database, Eye, EyeOff, LoaderCircle, Server, ShieldCheck, Waypoints } from 'lucide-react'
import { motion } from 'framer-motion'
import { discoverProxmox, validateProxmox } from '@/lib/api'
import { GlassCard } from '@/components/ui/GlassCard'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, fadeUpItem, isIPv4, staggerContainer } from '@/lib/utils'

export function ProxmoxStep() {
  const data = useWizardStore((state) => state.data)
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
  const [showToken, setShowToken] = useState(false)

  const applyHealthyStatus = (healthy: boolean) => {
    setStatus({
      ...(status ?? {
        env_saved: false,
        ssh_key: false,
        domain: false,
        cloudflare: false,
        deploy_running: false,
        proxmox: false,
      }),
      proxmox: healthy,
    })
  }

  const handleDiscover = async () => {
    if (!data.PROXMOX_HOST.trim() || !data.PROXMOX_API_TOKEN.trim()) return
    setLoading('discoverProxmox', true)
    try {
      const result = await discoverProxmox(data.PROXMOX_HOST.trim(), data.PROXMOX_API_TOKEN.trim())
      setProxmoxDiscovery(result)
      if (result.ok) {
        setFields({
          PROXMOX_NODE_NAME: result.node_name ?? data.PROXMOX_NODE_NAME,
          TALOS_DATASTORE: result.datastores?.[0] ?? data.TALOS_DATASTORE,
          NODE_1_VMID: result.vmid_suggestions?.[0]?.toString() ?? data.NODE_1_VMID,
          NODE_2_VMID: result.vmid_suggestions?.[1]?.toString() ?? data.NODE_2_VMID,
          NODE_3_VMID: result.vmid_suggestions?.[2]?.toString() ?? data.NODE_3_VMID,
        })
        applyHealthyStatus(true)
      }
    } finally {
      setLoading('discoverProxmox', false)
    }
  }

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

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Server}
        eyebrow="Step 3 of 8"
        title="Proxmox connectivity and discovery"
        description="Connect the wizard to your Proxmox VE API token, validate reachability, and pull the current node name, storage pools, and free VMID suggestions directly from the cluster."
      />

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <GlassCard className="p-6 md:p-8">
          <div className="grid gap-6 md:grid-cols-2">
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

            <FormField
              label="PROXMOX_API_TOKEN"
              htmlFor="PROXMOX_API_TOKEN"
              required
              hint={
                <>
                  Format: <code>USER@pve!TOKENNAME=uuid</code>. Create it in Datacenter → Permissions → API Tokens.
                </>
              }
            >
              <div className="relative">
                <input
                  id="PROXMOX_API_TOKEN"
                  type={showToken ? 'text' : 'password'}
                  value={data.PROXMOX_API_TOKEN}
                  onChange={(event) => setField('PROXMOX_API_TOKEN', event.target.value)}
                  placeholder="root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className={`${controlClassName} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((current) => !current)}
                  className="absolute inset-y-0 right-0 inline-flex w-12 items-center justify-center text-[var(--az-text-secondary)] transition hover:text-white"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </FormField>
          </div>

          <motion.div variants={fadeUpItem} className="mt-6 flex flex-wrap gap-3">
            <ActionButton variant="primary" onClick={handleDiscover} disabled={loading.discoverProxmox}>
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
              <div className="text-xs text-[var(--az-text-secondary)]">Successful discovery auto-fills the downstream cluster step.</div>
            </div>
          </motion.div>

          <div className="space-y-4">
            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">Node name</div>
              <div className="mt-2 text-lg font-semibold text-white">{data.PROXMOX_NODE_NAME || 'Waiting for discovery…'}</div>
            </motion.div>

            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">Storage pools</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(proxmoxDiscovery?.datastores?.length ? proxmoxDiscovery.datastores : [data.TALOS_DATASTORE]).map((pool) => (
                  <span key={pool} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white">
                    {pool}
                  </span>
                ))}
              </div>
            </motion.div>

            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">VMID suggestions</div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {[data.NODE_1_VMID, data.NODE_2_VMID, data.NODE_3_VMID].map((vmid, index) => (
                  <div key={vmid + index} className="rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-sm text-white">
                    Node {index + 1}: <span className="font-semibold">{vmid}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {proxmoxValidation ? (
              <motion.div
                variants={fadeUpItem}
                className={`rounded-2xl border p-4 text-sm ${proxmoxValidation.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}
              >
                {proxmoxValidation.ok ? `✅ Proxmox API reachable. Nodes: ${proxmoxValidation.nodes ?? 'available'}` : `✗ ${proxmoxValidation.error ?? 'Validation failed.'}`}
              </motion.div>
            ) : null}

            {proxmoxDiscovery ? (
              <motion.div
                variants={fadeUpItem}
                className={`rounded-2xl border p-4 text-sm ${proxmoxDiscovery.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}
              >
                {proxmoxDiscovery.ok ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Discovery complete for <strong>{proxmoxDiscovery.node_name}</strong>. Storage: <strong>{proxmoxDiscovery.datastores?.join(', ') || 'n/a'}</strong>. VMIDs:{' '}
                      <strong>{proxmoxDiscovery.vmid_suggestions?.slice(0, 3).join(', ') || 'n/a'}</strong>.
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
