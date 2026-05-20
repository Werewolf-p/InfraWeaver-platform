'use client'

import { LoaderCircle, Network, Sparkles, Waypoints } from 'lucide-react'
import { motion } from 'framer-motion'
import { pingCheck, suggestNodeIps, suggestVips } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { GlassCard } from '@/components/ui/GlassCard'
import { PingDot } from '@/components/ui/PingDot'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, fadeUpItem, isIPv4, staggerContainer } from '@/lib/utils'

const nodeRows = [
  { ipKey: 'NODE_1_IP', vmidKey: 'NODE_1_VMID', label: 'Node 1' },
  { ipKey: 'NODE_2_IP', vmidKey: 'NODE_2_VMID', label: 'Node 2' },
  { ipKey: 'NODE_3_IP', vmidKey: 'NODE_3_VMID', label: 'Node 3' },
] as const

const vipRows = [
  { key: 'METALLB_TRAEFIK_VIP', label: 'Traefik ingress' },
  { key: 'METALLB_COREDNS_VIP', label: 'CoreDNS' },
  { key: 'METALLB_NETBIRD_MGMT_VIP', label: 'NetBird management' },
  { key: 'METALLB_NETBIRD_SIGNAL_VIP', label: 'NetBird signal' },
  { key: 'METALLB_NETBIRD_RELAY_VIP', label: 'NetBird relay' },
] as const

export function ClusterStep() {
  const data = useWizardStore((state) => state.data)
  const loading = useWizardStore((state) => state.loading)
  const nodePing = useWizardStore((state) => state.nodePing)
  const vipPing = useWizardStore((state) => state.vipPing)
  const proxmoxDiscovery = useWizardStore((state) => state.proxmoxDiscovery)
  const setField = useWizardStore((state) => state.setField)
  const setFields = useWizardStore((state) => state.setFields)
  const setLoading = useWizardStore((state) => state.setLoading)
  const setNodePing = useWizardStore((state) => state.setNodePing)
  const setVipPing = useWizardStore((state) => state.setVipPing)

  const pingNodeField = async (field: keyof typeof nodePing) => {
    const ip = data[field].trim()
    if (!isIPv4(ip)) {
      setNodePing(field, null)
      return
    }
    setNodePing(field, 'loading')
    try {
      const result = await pingCheck(ip)
      setNodePing(field, typeof result.free === 'boolean' ? result.free : null)
    } catch {
      setNodePing(field, null)
    }
  }

  const pingVipField = async (field: keyof typeof vipPing) => {
    const ip = data[field].trim()
    if (!isIPv4(ip)) {
      setVipPing(field, null)
      return
    }
    setVipPing(field, 'loading')
    try {
      const result = await pingCheck(ip)
      setVipPing(field, typeof result.free === 'boolean' ? result.free : null)
    } catch {
      setVipPing(field, null)
    }
  }

  const handleSuggestNodes = async () => {
    if (!data.NODE_GATEWAY.trim()) return
    setLoading('suggestNodeIps', true)
    try {
      const result = await suggestNodeIps(data.NODE_GATEWAY.trim(), Number(data.NODE_SUBNET_PREFIX || '24'))
      if (result.ok && result.suggestions) {
        setFields({
          NODE_1_IP: result.suggestions[0]?.ip ?? data.NODE_1_IP,
          NODE_2_IP: result.suggestions[1]?.ip ?? data.NODE_2_IP,
          NODE_3_IP: result.suggestions[2]?.ip ?? data.NODE_3_IP,
        })
        result.suggestions.forEach((suggestion, index) => {
          const key = nodeRows[index]?.ipKey
          if (key) setNodePing(key, suggestion.free)
        })
      }
    } finally {
      setLoading('suggestNodeIps', false)
    }
  }

  const handleSuggestVips = async () => {
    if (!data.NODE_GATEWAY.trim()) return
    setLoading('suggestVips', true)
    try {
      const result = await suggestVips(data.NODE_GATEWAY.trim(), Number(data.NODE_SUBNET_PREFIX || '24'))
      if (result.ok) {
        const nextFields: Partial<typeof data> = {}
        if (result.range) nextFields.METALLB_VIP_RANGE = result.range
        result.vips?.forEach((vip) => {
          ;(nextFields as Record<string, string>)[vip.var] = vip.ip
          if (vip.var in vipPing) setVipPing(vip.var as keyof typeof vipPing, vip.free)
        })
        setFields(nextFields)
      }
    } finally {
      setLoading('suggestVips', false)
    }
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Network}
        eyebrow="Step 4 of 8"
        title="Cluster topology and load balancer VIPs"
        description="Define the Talos network, control-plane node IPs, VMIDs, and the MetalLB VIP pool. The wizard can suggest and ping-check candidate addresses directly from the selected subnet."
      />

      <GlassCard className="p-6 md:p-8">
        <div className="grid gap-6 lg:grid-cols-3">
          <FormField label="PROXMOX_NODE_NAME" htmlFor="PROXMOX_NODE_NAME" hint="Target node inside the Proxmox cluster.">
            <input
              id="PROXMOX_NODE_NAME"
              value={data.PROXMOX_NODE_NAME}
              onChange={(event) => setField('PROXMOX_NODE_NAME', event.target.value)}
              className={controlClassName}
            />
          </FormField>

          <FormField label="K8S_CLUSTER_NAME" htmlFor="K8S_CLUSTER_NAME" hint="Cluster name written into Talos and kubeconfig metadata.">
            <input
              id="K8S_CLUSTER_NAME"
              value={data.K8S_CLUSTER_NAME}
              onChange={(event) => setField('K8S_CLUSTER_NAME', event.target.value)}
              placeholder="infraweaver-prod"
              className={controlClassName}
            />
          </FormField>

          <FormField label="TALOS_DATASTORE" htmlFor="TALOS_DATASTORE" hint="Storage pool used for Talos VM disks.">
            {proxmoxDiscovery?.datastores?.length ? (
              <select
                id="TALOS_DATASTORE"
                value={data.TALOS_DATASTORE}
                onChange={(event) => setField('TALOS_DATASTORE', event.target.value)}
                className={controlClassName}
              >
                {proxmoxDiscovery.datastores.map((pool) => (
                  <option key={pool} value={pool}>
                    {pool}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="TALOS_DATASTORE"
                value={data.TALOS_DATASTORE}
                onChange={(event) => setField('TALOS_DATASTORE', event.target.value)}
                className={controlClassName}
              />
            )}
          </FormField>

          <FormField label="NODE_GATEWAY" htmlFor="NODE_GATEWAY" hint="Default gateway for the Talos node subnet.">
            <input
              id="NODE_GATEWAY"
              value={data.NODE_GATEWAY}
              onChange={(event) => setField('NODE_GATEWAY', event.target.value)}
              className={controlClassName}
            />
          </FormField>

          <FormField label="NODE_SUBNET_PREFIX" htmlFor="NODE_SUBNET_PREFIX" hint="Example: 24 = 255.255.255.0">
            <input
              id="NODE_SUBNET_PREFIX"
              value={data.NODE_SUBNET_PREFIX}
              onChange={(event) => setField('NODE_SUBNET_PREFIX', event.target.value)}
              className={controlClassName}
            />
          </FormField>

          <FormField label="CLUSTER_LOCAL_DOMAIN" htmlFor="CLUSTER_LOCAL_DOMAIN" hint="Internal Talos cluster DNS zone.">
            <input
              id="CLUSTER_LOCAL_DOMAIN"
              value={data.CLUSTER_LOCAL_DOMAIN}
              onChange={(event) => setField('CLUSTER_LOCAL_DOMAIN', event.target.value)}
              placeholder="prod.local"
              className={controlClassName}
            />
          </FormField>
        </div>
      </GlassCard>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">Control plane nodes</div>
              <div className="text-sm text-[var(--az-text-secondary)]">IPs are ping-checked on blur. Use the helper to suggest .90/.91/.92 from the current gateway subnet.</div>
            </div>
            <ActionButton variant="primary" onClick={handleSuggestNodes} disabled={loading.suggestNodeIps}>
              {loading.suggestNodeIps ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Waypoints className="h-4 w-4" />}
              🧲 Suggest IPs
            </ActionButton>
          </motion.div>

          <div className="space-y-4">
            {nodeRows.map((row) => (
              <motion.div key={row.ipKey} variants={fadeUpItem} className="grid gap-4 rounded-2xl border border-white/8 bg-black/20 p-4 md:grid-cols-[1.2fr_0.8fr]">
                <FormField
                  label={row.label + ' IP'}
                  htmlFor={row.ipKey}
                  hint="Green means the address did not reply to ping. Red means it is already in use."
                >
                  <div className="flex items-center gap-3">
                    <PingDot state={nodePing[row.ipKey]} />
                    <input
                      id={row.ipKey}
                      value={data[row.ipKey]}
                      onChange={(event) => setField(row.ipKey, event.target.value)}
                      onBlur={() => void pingNodeField(row.ipKey)}
                      className={controlClassName}
                    />
                  </div>
                </FormField>
                <FormField label={row.label + ' VMID'} htmlFor={row.vmidKey} hint="Must be unique in the Proxmox cluster.">
                  <input
                    id={row.vmidKey}
                    value={data[row.vmidKey]}
                    onChange={(event) => setField(row.vmidKey, event.target.value)}
                    className={controlClassName}
                  />
                </FormField>
              </motion.div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">MetalLB VIP plan</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Suggested VIPs land in the .200 range and are ping-checked automatically.</div>
            </div>
            <ActionButton variant="primary" onClick={handleSuggestVips} disabled={loading.suggestVips}>
              {loading.suggestVips ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              ✨ Auto-suggest & ping-check
            </ActionButton>
          </motion.div>

          <div className="space-y-4">
            <FormField label="METALLB_VIP_RANGE" htmlFor="METALLB_VIP_RANGE" hint="Full pool range that covers every VIP below.">
              <input
                id="METALLB_VIP_RANGE"
                value={data.METALLB_VIP_RANGE}
                onChange={(event) => setField('METALLB_VIP_RANGE', event.target.value)}
                className={controlClassName}
              />
            </FormField>

            <div className="grid gap-4 md:grid-cols-2">
              {vipRows.map((row) => (
                <motion.div key={row.key} variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                  <FormField label={row.key} htmlFor={row.key} hint={row.label}>
                    <div className="flex items-center gap-3">
                      <PingDot state={vipPing[row.key]} />
                      <input
                        id={row.key}
                        value={data[row.key]}
                        onChange={(event) => setField(row.key, event.target.value)}
                        onBlur={() => void pingVipField(row.key)}
                        className={controlClassName}
                      />
                    </div>
                  </FormField>
                </motion.div>
              ))}
            </div>
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
