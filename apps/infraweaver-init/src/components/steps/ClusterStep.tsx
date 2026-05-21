'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  HardDrive,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { discoverProxmox, pingCheck, suggestNodeIps, suggestVips, type NodeDatastore } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { GlassCard } from '@/components/ui/GlassCard'
import { PingDot } from '@/components/ui/PingDot'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type NodeConfig } from '@/lib/store'
import { controlClassName, fadeUpItem, isIPv4, staggerContainer } from '@/lib/utils'

const vipRows = [
  { key: 'METALLB_TRAEFIK_VIP', label: 'Traefik ingress' },
  { key: 'METALLB_COREDNS_VIP', label: 'CoreDNS' },
  { key: 'METALLB_NETBIRD_MGMT_VIP', label: 'NetBird management' },
  { key: 'METALLB_NETBIRD_SIGNAL_VIP', label: 'NetBird signal' },
  { key: 'METALLB_NETBIRD_RELAY_VIP', label: 'NetBird relay' },
] as const

function dsValue(ds: NodeDatastore | string): string {
  return typeof ds === 'object' ? ds.name : ds
}
function dsLabel(ds: NodeDatastore | string): string {
  if (typeof ds === 'object' && ds.free_gb != null) return `${ds.name}  (${ds.free_gb} GB free)`
  return typeof ds === 'object' ? ds.name : ds
}

function ResourceBadge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </div>
  )
}

function RoleBadge({ role }: { role: NodeConfig['role'] }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${role === 'control-plane' ? 'border-[rgba(0,120,212,0.35)] bg-[rgba(0,120,212,0.12)] text-[var(--az-primary)]' : 'border-[rgba(87,163,0,0.3)] bg-[rgba(87,163,0,0.12)] text-[var(--az-success)]'}`}
    >
      {role === 'control-plane' ? 'CP' : 'Worker'}
    </span>
  )
}

export function ClusterStep() {
  const data = useWizardStore((state) => state.data)
  const nodes = useWizardStore((state) => state.nodes)
  const loading = useWizardStore((state) => state.loading)
  const nodePing = useWizardStore((state) => state.nodePing)
  const vipPing = useWizardStore((state) => state.vipPing)
  const proxmoxDiscovery = useWizardStore((state) => state.proxmoxDiscovery)
  const setField = useWizardStore((state) => state.setField)
  const setFields = useWizardStore((state) => state.setFields)
  const addNode = useWizardStore((state) => state.addNode)
  const removeNode = useWizardStore((state) => state.removeNode)
  const updateNode = useWizardStore((state) => state.updateNode)
  const setLoading = useWizardStore((state) => state.setLoading)
  const setNodePing = useWizardStore((state) => state.setNodePing)
  const setVipPing = useWizardStore((state) => state.setVipPing)
  const setProxmoxDiscovery = useWizardStore((state) => state.setProxmoxDiscovery)

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const pingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const controlPlaneCount = useMemo(
    () => nodes.filter((node) => node.role === 'control-plane').length,
    [nodes],
  )
  const totalCpu = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.cpu || 0), 0),
    [nodes],
  )
  const totalRam = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.memory || 0), 0),
    [nodes],
  )
  const totalDisk = useMemo(
    () => nodes.reduce((sum, node) => sum + Number(node.disk || 0), 0),
    [nodes],
  )

  const pingNode = useCallback(async (nodeData: { id: string; ip: string }) => {
    const ip = nodeData.ip.trim()
    if (!isIPv4(ip)) {
      setNodePing(nodeData.id, null)
      return
    }
    setNodePing(nodeData.id, 'loading')
    try {
      const result = await pingCheck(ip)
      setNodePing(nodeData.id, typeof result.free === 'boolean' ? result.free : null)
    } catch {
      setNodePing(nodeData.id, null)
    }
  }, [setNodePing])

  // Auto-ping any nodes that already have a valid IP when the step first mounts
  useEffect(() => {
    nodes.forEach((node) => {
      if (isIPv4(node.ip.trim()) && nodePing[node.id] === undefined) {
        void pingNode(node)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Background-fetch Proxmox node list if not already populated (makes PVE dropdown always work)
  useEffect(() => {
    if (proxmoxDiscovery?.all_nodes?.length) return
    const host = data.PROXMOX_HOST?.trim()
    const token = data.PROXMOX_API_TOKEN?.trim()
    if (!host || !token) return
    void discoverProxmox(host, token).then((result) => {
      if (result.ok) setProxmoxDiscovery(result)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      if (result.ok && result.suggestions?.length) {
        result.suggestions.slice(0, 3).forEach((suggestion, index) => {
          const node = nodes[index]
          if (!node) return
          updateNode(node.id, { ip: suggestion.ip })
          setNodePing(node.id, suggestion.free)
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

  const handleRoleChange = (node: NodeConfig, nextRole: NodeConfig['role']) => {
    const firstNodeId = nodes[0]?.id
    if (node.id === firstNodeId) return
    if (nextRole === 'worker' && node.role === 'control-plane' && controlPlaneCount <= 1) return
    updateNode(node.id, { role: nextRole })
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={HardDrive}
        eyebrow="Step 4 of 8"
        title="Dynamic cluster builder and VIP plan"
        description="Shape your Talos node pool with per-node roles, budgets, and Proxmox placement. The wizard still keeps MetalLB VIP planning in the same place, now with dynamic node serialization under the hood."
      />

      <GlassCard className="p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)]">Resource budget</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ResourceBadge color="#0078D4">{totalCpu} vCPU</ResourceBadge>
              <ResourceBadge color="#57A300">{(totalRam / 1024).toFixed(1)} GB RAM</ResourceBadge>
              <ResourceBadge color="#D47500">{totalDisk} GB disk</ResourceBadge>
            </div>
          </div>
          {controlPlaneCount < 3 ? (
            <div className="rounded-2xl border border-[rgba(212,117,0,0.3)] bg-[rgba(212,117,0,0.08)] px-4 py-3 text-sm text-[var(--az-text-secondary)]">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--az-warning)]" />
                <span>
                  <strong className="text-white">HA warning:</strong> fewer than 3 control-plane nodes means no highly-available control plane.
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <FormField label="K8S_CLUSTER_NAME" htmlFor="K8S_CLUSTER_NAME" hint="Cluster name written into Talos and kubeconfig metadata.">
            <input
              id="K8S_CLUSTER_NAME"
              value={data.K8S_CLUSTER_NAME}
              onChange={(event) => setField('K8S_CLUSTER_NAME', event.target.value)}
              placeholder="infraweaver-prod"
              className={controlClassName}
            />
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
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="mt-5 flex items-center gap-1.5 text-xs text-[var(--az-text-secondary)] transition hover:text-white"
        >
          {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          ⚙ Advanced cluster defaults
        </button>

        {advancedOpen ? (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4 grid gap-4 md:grid-cols-2">
            <FormField label="TALOS_DATASTORE" htmlFor="TALOS_DATASTORE" hint="Global default storage pool used when a node-specific datastore is empty.">
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
            <FormField label="CLUSTER_LOCAL_DOMAIN" htmlFor="CLUSTER_LOCAL_DOMAIN" hint="Internal Talos cluster DNS zone.">
              <input
                id="CLUSTER_LOCAL_DOMAIN"
                value={data.CLUSTER_LOCAL_DOMAIN}
                onChange={(event) => setField('CLUSTER_LOCAL_DOMAIN', event.target.value)}
                placeholder="prod.local"
                className={controlClassName}
              />
            </FormField>
          </motion.div>
        ) : null}
      </GlassCard>

      <GlassCard className="p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-white">Node pool</div>
            <div className="text-sm text-[var(--az-text-secondary)]">First node stays control-plane. Additional nodes can be promoted or demoted as needed.</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <ActionButton variant="secondary" onClick={handleSuggestNodes} disabled={loading.suggestNodeIps}>
              {loading.suggestNodeIps ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Waypoints className="h-4 w-4" />}
              🧲 Suggest node IPs
            </ActionButton>
            <ActionButton variant="primary" onClick={addNode} disabled={nodes.length >= 6}>
              <Plus className="h-4 w-4" />
              Add Node
            </ActionButton>
          </div>
        </div>

        <div className="space-y-4">
          {nodes.map((node, index) => {
            const isExpanded = expandedNodes.has(node.id)
            const availableNodes = proxmoxDiscovery?.all_nodes ?? []
            const selectedPveNode = node.pveNode || data.PROXMOX_NODE_NAME
            const nodeResources = proxmoxDiscovery?.node_resources_by_node?.[selectedPveNode]
            const availableDatastores: Array<NodeDatastore | string> =
              proxmoxDiscovery?.datastores_by_node?.[selectedPveNode] ?? proxmoxDiscovery?.datastores ?? []
            const canRemove = nodes.length > 1 && !(node.role === 'control-plane' && controlPlaneCount === 1)

            return (
              <motion.div key={node.id} variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-base font-semibold text-white">Node {index + 1}</div>
                      <RoleBadge role={node.role} />
                    </div>
                    <div className="mt-1 text-sm text-[var(--az-text-secondary)]">{node.id} · assign an IP, VMID, and optional worker role.</div>
                  </div>
                  <ActionButton variant="ghost" onClick={() => removeNode(node.id)} disabled={!canRemove} className="px-3 py-3">
                    <Trash2 className="h-4 w-4" />
                  </ActionButton>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
                  <FormField label="Node IP" htmlFor={`${node.id}-ip`} hint="Green = free, red = already in use.">
                    <div className="flex items-center gap-3">
                      <PingDot state={nodePing[node.id] ?? null} />
                      <input
                        id={`${node.id}-ip`}
                        value={node.ip}
                        onChange={(event) => {
                          const newIp = event.target.value
                          updateNode(node.id, { ip: newIp })
                          if (pingTimersRef.current[node.id]) clearTimeout(pingTimersRef.current[node.id])
                          if (!isIPv4(newIp.trim())) { setNodePing(node.id, null); return }
                          pingTimersRef.current[node.id] = setTimeout(
                            () => void pingNode({ id: node.id, ip: newIp }),
                            700,
                          )
                        }}
                        className={controlClassName}
                      />
                    </div>
                  </FormField>
                  <FormField label="VMID" htmlFor={`${node.id}-vmid`} hint="Must be unique inside the Proxmox cluster.">
                    <input
                      id={`${node.id}-vmid`}
                      value={node.vmid}
                      onChange={(event) => updateNode(node.id, { vmid: event.target.value })}
                      className={controlClassName}
                    />
                  </FormField>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <FormField label="Role" htmlFor={`${node.id}-role`} hint="Keep at least one control-plane node. Three is recommended for HA.">
                    <div className="grid grid-cols-2 gap-2">
                      {(['control-plane', 'worker'] as const).map((role) => {
                        const disabled = node.id === nodes[0]?.id && role === 'worker'
                        return (
                          <button
                            key={role}
                            id={role === 'control-plane' ? `${node.id}-role` : undefined}
                            type="button"
                            disabled={disabled}
                            onClick={() => handleRoleChange(node, role)}
                            className={`rounded-xl border px-4 py-3 text-sm transition ${node.role === role ? 'border-[rgba(0,120,212,0.45)] bg-[rgba(0,120,212,0.16)] text-white' : 'border-white/10 bg-white/5 text-[var(--az-text-secondary)] hover:text-white'} disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            {role === 'control-plane' ? 'Control plane' : 'Worker'}
                          </button>
                        )
                      })}
                    </div>
                  </FormField>

                  <FormField
                    label="PVE node"
                    htmlFor={`${node.id}-pve`}
                    hint={nodeResources
                      ? `🖥 ${nodeResources.cpu_cores} cores · 🧮 ${Math.round(nodeResources.mem_total_mb / 1024)} GB RAM · 💾 ${Math.round(nodeResources.mem_free_mb / 1024)} GB free`
                      : 'Which Proxmox node hosts this VM.'}
                  >
                    {availableNodes.length ? (
                      <select
                        id={`${node.id}-pve`}
                        value={selectedPveNode}
                        onChange={(event) => updateNode(node.id, { pveNode: event.target.value })}
                        className={controlClassName}
                      >
                        {availableNodes.map((availableNode) => (
                          <option key={availableNode} value={availableNode}>
                            {availableNode}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`${node.id}-pve`}
                        value={node.pveNode}
                        onChange={(event) => updateNode(node.id, { pveNode: event.target.value })}
                        placeholder={data.PROXMOX_NODE_NAME || 'pve'}
                        className={controlClassName}
                      />
                    )}
                  </FormField>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setExpandedNodes((current) => {
                      const next = new Set(current)
                      if (next.has(node.id)) next.delete(node.id)
                      else next.add(node.id)
                      return next
                    })
                  }
                  className="mt-4 flex items-center gap-1.5 text-xs text-[var(--az-text-secondary)] transition hover:text-white"
                >
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  ⚙ Advanced (CPU / RAM / Disk / Datastore)
                </button>

                {isExpanded ? (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <FormField
                      label={`CPU cores${nodeResources ? ` (node has ${nodeResources.cpu_cores})` : ''}`}
                      htmlFor={`${node.id}-cpu`}
                    >
                      <input
                        id={`${node.id}-cpu`}
                        type="number"
                        min={1}
                        max={nodeResources?.cpu_cores ?? 128}
                        value={node.cpu}
                        onChange={(event) => updateNode(node.id, { cpu: event.target.value })}
                        className={controlClassName}
                      />
                    </FormField>
                    <FormField
                      label={`RAM MB${nodeResources ? ` (node has ${Math.round(nodeResources.mem_total_mb / 1024)} GB)` : ''}`}
                      htmlFor={`${node.id}-memory`}
                    >
                      <input
                        id={`${node.id}-memory`}
                        type="number"
                        min={512}
                        step={512}
                        value={node.memory}
                        onChange={(event) => updateNode(node.id, { memory: event.target.value })}
                        className={controlClassName}
                      />
                    </FormField>
                    <FormField label="Disk GB" htmlFor={`${node.id}-disk`}>
                      <input
                        id={`${node.id}-disk`}
                        type="number"
                        min={10}
                        value={node.disk}
                        onChange={(event) => updateNode(node.id, { disk: event.target.value })}
                        className={controlClassName}
                      />
                    </FormField>
                    <FormField
                      label="Datastore"
                      htmlFor={`${node.id}-datastore`}
                      hint={availableDatastores.length ? `${availableDatastores.length} pool${availableDatastores.length > 1 ? 's' : ''} on ${selectedPveNode}` : undefined}
                    >
                      {availableDatastores.length ? (
                        <select
                          id={`${node.id}-datastore`}
                          value={node.datastore || dsValue(availableDatastores[0])}
                          onChange={(event) => updateNode(node.id, { datastore: event.target.value })}
                          className={controlClassName}
                        >
                          {availableDatastores.map((ds) => (
                            <option key={dsValue(ds)} value={dsValue(ds)}>
                              {dsLabel(ds)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`${node.id}-datastore`}
                          value={node.datastore}
                          onChange={(event) => updateNode(node.id, { datastore: event.target.value })}
                          placeholder={data.TALOS_DATASTORE}
                          className={controlClassName}
                        />
                      )}
                    </FormField>
                  </motion.div>
                ) : null}
              </motion.div>
            )
          })}
        </div>
      </GlassCard>

      <GlassCard className="p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-white">MetalLB VIP plan</div>
            <div className="text-sm text-[var(--az-text-secondary)]">Suggested VIPs land in the .200 range and are ping-checked automatically.</div>
          </div>
          <ActionButton variant="primary" onClick={handleSuggestVips} disabled={loading.suggestVips}>
            {loading.suggestVips ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            ✨ Auto-suggest & ping-check
          </ActionButton>
        </div>

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
    </motion.div>
  )
}
