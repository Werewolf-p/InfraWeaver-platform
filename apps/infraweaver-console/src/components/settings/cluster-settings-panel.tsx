"use client";

import { motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface NodeMetric {
  name: string;
  cpuPct: number;
  memPct: number;
  cpuMillicores: number;
  memKi: number;
}

interface NodeSpec {
  name: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  ip: string;
  vm_id: number;
  proxmox_node: string;
  controlplane: boolean;
}

interface NodeSpecsResponse {
  nodes: NodeSpec[];
  sha: string;
}

interface NodeSpecsResult {
  ok: boolean;
  changedNodes: string[];
  workflowDispatched: string;
}

interface ResourceSettingDef {
  key: string;
  group: string;
  label: string;
  description: string;
  type: "string" | "number" | "select";
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  argoApp: string;
}

interface ClusterSettingsResponse {
  schema: ResourceSettingDef[];
  values: Record<string, unknown>;
  files: Record<string, string>;
}

interface SaveResult {
  ok: boolean;
  affectedApps: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function metricColor(pct: number) {
  if (pct >= 85) return "bg-red-500";
  if (pct >= 65) return "bg-amber-400";
  return "bg-emerald-500";
}

function metricTextColor(pct: number) {
  if (pct >= 85) return "text-red-400";
  if (pct >= 65) return "text-amber-400";
  return "text-emerald-400";
}

function fmtMem(ki: number) {
  if (ki >= 1_048_576) return `${(ki / 1_048_576).toFixed(1)} GiB`;
  if (ki >= 1_024) return `${Math.round(ki / 1_024)} MiB`;
  return `${ki} KiB`;
}

// ── Node Overview ──────────────────────────────────────────────────────────────

function NodeCard({ metric }: { metric: NodeMetric }) {
  const shortName = metric.name.replace("talos-prod-", "");
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3b82f6]/15 text-[#60a5fa]">
          <Server className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-[#f2f2f2] capitalize">{shortName}</p>
          <p className="text-xs text-[#666]">{metric.name}</p>
        </div>
      </div>

      {/* CPU */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 text-[#888]" />
            <span className="text-xs text-[#888]">CPU</span>
          </div>
          <span className={cn("text-xs font-mono font-semibold", metricTextColor(metric.cpuPct))}>
            {metric.cpuPct}% · {metric.cpuMillicores}m
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[#2a2a2a]">
          <div
            className={cn("h-1.5 rounded-full transition-all duration-500", metricColor(metric.cpuPct))}
            style={{ width: `${metric.cpuPct}%` }}
          />
        </div>
      </div>

      {/* Memory */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <MemoryStick className="h-3.5 w-3.5 text-[#888]" />
            <span className="text-xs text-[#888]">Memory</span>
          </div>
          <span className={cn("text-xs font-mono font-semibold", metricTextColor(metric.memPct))}>
            {metric.memPct}% · {fmtMem(metric.memKi)}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[#2a2a2a]">
          <div
            className={cn("h-1.5 rounded-full transition-all duration-500", metricColor(metric.memPct))}
            style={{ width: `${metric.memPct}%` }}
          />
        </div>
      </div>
    </motion.div>
  );
}

function NodeOverview() {
  const { data, isLoading } = useQuery<{ metrics: NodeMetric[] }>({
    queryKey: ["cluster", "metrics"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/metrics");
      return res.json() as Promise<{ metrics: NodeMetric[] }>;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  const metrics = data?.metrics ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-[#888]" />
        <h3 className="text-sm font-medium text-[#ccc]">Node Resources</h3>
        <span className="ml-auto text-xs text-[#555]">Live · refreshes every 30s</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((m) => <NodeCard key={m.name} metric={m} />)}
      </div>
    </div>
  );
}

// ── Node Specs Editor ──────────────────────────────────────────────────────────

interface LocalNodeSpec {
  cpu: number;
  memory_mb: number;
}

function fmtMemMb(mb: number) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
  return `${mb} MiB`;
}

function NodeSpecCard({
  spec,
  local,
  onChange,
  disabled,
}: {
  spec: NodeSpec;
  local: LocalNodeSpec;
  onChange: (name: string, field: keyof LocalNodeSpec, value: number) => void;
  disabled: boolean;
}) {
  const cpuDirty = local.cpu !== spec.cpu;
  const memDirty = local.memory_mb !== spec.memory_mb;
  const anyDirty = cpuDirty || memDirty;
  const shortName = spec.name.replace("talos-prod-", "");

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-xl border bg-[#111] p-5 space-y-4 transition-colors",
        anyDirty ? "border-amber-500/30" : "border-[#2a2a2a]",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3b82f6]/15 text-[#60a5fa]">
          <Server className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#f2f2f2] capitalize">{shortName}</p>
          <p className="text-xs text-[#555]">{spec.ip} · VM {spec.vm_id}</p>
        </div>
        {anyDirty && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            changed
          </span>
        )}
      </div>

      {/* CPU */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 text-[#888]" />
            <span className="text-xs text-[#888]">vCPU cores</span>
          </div>
          {cpuDirty && (
            <span className="text-[10px] text-amber-400">{spec.cpu} → {local.cpu}</span>
          )}
        </div>
        <input
          type="number"
          min={1}
          max={64}
          value={local.cpu}
          onChange={(e) => onChange(spec.name, "cpu", Math.max(1, Math.min(64, parseInt(e.target.value) || 1)))}
          disabled={disabled}
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* Memory */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <MemoryStick className="h-3.5 w-3.5 text-[#888]" />
            <span className="text-xs text-[#888]">Memory (MB)</span>
          </div>
          {memDirty ? (
            <span className="text-[10px] text-amber-400">
              {fmtMemMb(spec.memory_mb)} → {fmtMemMb(local.memory_mb)}
            </span>
          ) : (
            <span className="text-[10px] text-[#555]">{fmtMemMb(local.memory_mb)}</span>
          )}
        </div>
        <input
          type="number"
          min={512}
          max={131072}
          step={512}
          value={local.memory_mb}
          onChange={(e) => {
            const raw = parseInt(e.target.value) || 512;
            // Snap to nearest 512 MB
            const snapped = Math.round(raw / 512) * 512;
            onChange(spec.name, "memory_mb", Math.max(512, Math.min(131072, snapped)));
          }}
          disabled={disabled}
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-[11px] text-[#555]">Must be a multiple of 512 MB · {spec.disk_gb} GB disk (read-only)</p>
      </div>
    </motion.div>
  );
}

function NodeSpecsEditorContent({ data, canWrite }: { data: NodeSpecsResponse; canWrite: boolean }) {
  const queryClient = useQueryClient();

  const [local, setLocal] = useState<Record<string, LocalNodeSpec>>(() =>
    Object.fromEntries(data.nodes.map((n) => [n.name, { cpu: n.cpu, memory_mb: n.memory_mb }])),
  );

  useEffect(() => {
    setLocal(Object.fromEntries(data.nodes.map((n) => [n.name, { cpu: n.cpu, memory_mb: n.memory_mb }])));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const [showConfirm, setShowConfirm] = useState(false);

  const dirtyNodes = useMemo(
    () =>
      data.nodes.filter(
        (n) => local[n.name]?.cpu !== n.cpu || local[n.name]?.memory_mb !== n.memory_mb,
      ),
    [data.nodes, local],
  );

  const handleChange = useCallback((name: string, field: keyof LocalNodeSpec, value: number) => {
    setLocal((prev) => ({ ...prev, [name]: { ...prev[name], [field]: value } }));
  }, []);

  const handleReset = useCallback(() => {
    setLocal(Object.fromEntries(data.nodes.map((n) => [n.name, { cpu: n.cpu, memory_mb: n.memory_mb }])));
  }, [data]);

  const saveMutation = useMutation<NodeSpecsResult, Error>({
    mutationFn: async () => {
      const changes = dirtyNodes.map((n) => ({
        name: n.name,
        cpu: local[n.name].cpu,
        memory_mb: local[n.name].memory_mb,
      }));
      const res = await fetch("/api/cluster/nodes/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const payload = (await res.json()) as NodeSpecsResult & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to save");
      return payload;
    },
    onSuccess: (result) => {
      toast.success(
        `Node specs committed · rolling update workflow dispatched for: ${result.changedNodes.join(", ")}`,
        { duration: 8000 },
      );
      void queryClient.invalidateQueries({ queryKey: ["cluster", "node-specs"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-[#888]" />
        <h3 className="text-sm font-medium text-[#ccc]">Node Specs (CPU / Memory)</h3>
        <span className="ml-auto text-xs text-[#555]">Changes drain → resize → uncordon each node</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {data.nodes.map((spec) => (
          <NodeSpecCard
            key={spec.name}
            spec={spec}
            local={local[spec.name] ?? { cpu: spec.cpu, memory_mb: spec.memory_mb }}
            onChange={handleChange}
            disabled={!canWrite || saveMutation.isPending}
          />
        ))}
      </div>

      {dirtyNodes.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#f2f2f2]">
                {dirtyNodes.length} node{dirtyNodes.length > 1 ? "s" : ""} to update
              </p>
              <p className="mt-1 text-xs text-[#888]">
                Commits changes to git and dispatches a GitHub Actions workflow that drains, resizes (Proxmox), and uncordons each node one at a time. Expect 5–10 min per node.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {dirtyNodes.map((n) => (
                  <span key={n.name} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-[#d4d4d4]">
                    {n.name.replace("talos-prod-", "")}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleReset}
                disabled={saveMutation.isPending}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 text-sm font-medium text-[#d4d4d4] hover:bg-white/10 disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={!canWrite || saveMutation.isPending}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white hover:bg-[#2563eb] disabled:opacity-60"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Workflow className="h-3.5 w-3.5" />
                )}
                Apply & Rolling Update
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {!canWrite && (
        <p className="text-xs text-[#555]">
          <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
          Config write permission required to resize nodes.
        </p>
      )}

      <ConfirmDialog
        open={showConfirm}
        onCancel={() => setShowConfirm(false)}
        onConfirm={() => { setShowConfirm(false); saveMutation.mutate(); }}
        title="Apply node spec changes?"
        description={`This commits changes to git and dispatches a rolling-update workflow. Each node (${dirtyNodes.map((n) => n.name.replace("talos-prod-", "")).join(", ")}) will be drained, resized in Proxmox, then uncordoned — one at a time. Expect 5–10 min per node.`}
        confirmText="Drain & resize"
      />
    </div>
  );
}

function NodeSpecsEditor({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useQuery<NodeSpecsResponse, Error>({
    queryKey: ["cluster", "node-specs"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/nodes/settings");
      const payload = (await res.json()) as NodeSpecsResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to load node specs");
      return payload;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm">
        <AlertCircle className="mr-2 inline h-4 w-4 text-red-400" />
        <span className="text-red-200">{error.message}</span>
        <button onClick={() => void refetch()} className="ml-3 underline text-red-300 hover:text-red-100">Retry</button>
      </div>
    );
  }

  if (!data) return null;
  return <NodeSpecsEditorContent data={data} canWrite={canWrite} />;
}

// ── Resource Editor ─────────────────────────────────────────────────────────────

interface ResourceFieldProps {
  def: ResourceSettingDef;
  value: string;
  onChange: (key: string, value: string) => void;
  disabled: boolean;
  isDirty: boolean;
}

function ResourceField({ def, value, onChange, disabled, isDirty }: ResourceFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-[#ccc]">{def.label}</label>
        {def.unit && (
          <span className="rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-1.5 py-0.5 text-[10px] text-[#666]">
            {def.unit}
          </span>
        )}
        {isDirty && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            changed
          </span>
        )}
      </div>
      {def.type === "select" ? (
        <select
          value={value}
          onChange={(e) => onChange(def.key, e.target.value)}
          disabled={disabled}
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {def.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : (
        <input
          type={def.type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(def.key, e.target.value)}
          disabled={disabled}
          min={def.min}
          max={def.max}
          placeholder={def.placeholder ?? ""}
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#f2f2f2] placeholder-[#444] focus:border-[#3b82f6] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
      )}
      <p className="text-[11px] text-[#555]">{def.description}</p>
    </div>
  );
}

const GROUP_COLORS: Record<string, { badge: string; dot: string }> = {
  Authentik: { badge: "border-violet-500/20 bg-violet-500/10 text-violet-300", dot: "bg-violet-400" },
  ArgoCD: { badge: "border-[#3b82f6]/20 bg-[#3b82f6]/10 text-[#60a5fa]", dot: "bg-[#60a5fa]" },
  Grafana: { badge: "border-amber-500/20 bg-amber-500/10 text-amber-300", dot: "bg-amber-400" },
  Longhorn: { badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
};

function ResourceEditorContent({
  data,
  canWrite,
}: {
  data: ClusterSettingsResponse;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();

  const [local, setLocal] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.schema.map((def) => [def.key, String(data.values[def.key] ?? "")]),
    ),
  );

  useEffect(() => {
    setLocal(Object.fromEntries(data.schema.map((def) => [def.key, String(data.values[def.key] ?? "")])));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const [showConfirm, setShowConfirm] = useState(false);

  const dirtyKeys = useMemo(
    () => new Set(data.schema.filter((def) => local[def.key] !== String(data.values[def.key] ?? "")).map((def) => def.key)),
    [data, local],
  );

  const affectedApps = useMemo(
    () => [...new Set(data.schema.filter((def) => dirtyKeys.has(def.key)).map((def) => def.argoApp))],
    [data.schema, dirtyKeys],
  );

  const handleChange = useCallback((key: string, value: string) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setLocal(Object.fromEntries(data.schema.map((def) => [def.key, String(data.values[def.key] ?? "")])));
  }, [data]);

  const saveMutation = useMutation<SaveResult, Error>({
    mutationFn: async () => {
      const changes = [...dirtyKeys].map((key) => ({ key, value: local[key] }));
      const res = await fetch("/api/cluster/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const payload = (await res.json()) as SaveResult & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to save");
      return payload;
    },
    onSuccess: (result) => {
      toast.success(
        `Changes committed · rolling update triggered for: ${result.affectedApps.join(", ")}`,
        { duration: 6000 },
      );
      void queryClient.invalidateQueries({ queryKey: ["cluster", "settings"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const handleApply = useCallback(() => {
    setShowConfirm(false);
    saveMutation.mutate();
  }, [saveMutation]);

  // Group defs by service
  const groups = useMemo(() => {
    const map = new Map<string, ResourceSettingDef[]>();
    for (const def of data.schema) {
      const arr = map.get(def.group) ?? [];
      arr.push(def);
      map.set(def.group, arr);
    }
    return map;
  }, [data.schema]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-[#888]" />
        <h3 className="text-sm font-medium text-[#ccc]">Service Resource Limits</h3>
        <span className="ml-auto text-xs text-[#555]">Changes commit to git → ArgoCD rolling update</span>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {[...groups.entries()].map(([groupName, defs]) => {
          const colors = GROUP_COLORS[groupName] ?? {
            badge: "border-white/10 bg-white/5 text-[#ccc]",
            dot: "bg-[#888]",
          };
          const groupDirty = defs.some((d) => dirtyKeys.has(d.key));
          return (
            <motion.div
              key={groupName}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-[#2a2a2a] bg-[#111] p-5 space-y-4"
            >
              <div className="flex items-center gap-2">
                <div className={cn("h-2 w-2 rounded-full", colors.dot)} />
                <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", colors.badge)}>
                  {groupName}
                </span>
                {groupDirty && (
                  <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                    unsaved changes
                  </span>
                )}
              </div>
              {defs.map((def) => (
                <ResourceField
                  key={def.key}
                  def={def}
                  value={local[def.key] ?? ""}
                  onChange={handleChange}
                  disabled={!canWrite || saveMutation.isPending}
                  isDirty={dirtyKeys.has(def.key)}
                />
              ))}
            </motion.div>
          );
        })}
      </div>

      {dirtyKeys.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#f2f2f2]">
                {dirtyKeys.size} unsaved change{dirtyKeys.size > 1 ? "s" : ""}
              </p>
              <p className="mt-1 text-xs text-[#888]">
                Saving commits to git and triggers a rolling update for the affected apps. No downtime — pods are replaced one at a time.
              </p>
              {affectedApps.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {affectedApps.map((app) => (
                    <span key={app} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-[#d4d4d4]">
                      {app}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleReset}
                disabled={saveMutation.isPending}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 text-sm font-medium text-[#d4d4d4] hover:bg-white/10 disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={!canWrite || saveMutation.isPending}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white hover:bg-[#2563eb] disabled:opacity-60"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Apply Changes
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {!canWrite && (
        <p className="text-xs text-[#555]">
          <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
          You have read-only access. Config write permission required to save changes.
        </p>
      )}

      <ConfirmDialog
        open={showConfirm}
        onCancel={() => setShowConfirm(false)}
        onConfirm={handleApply}
        title="Apply resource changes?"
        description={`This commits changes to git and triggers rolling updates for: ${affectedApps.join(", ")}. Pods are replaced one at a time — no downtime.`}
        confirmText="Commit & deploy"
      />
    </div>
  );
}

function ResourceEditorLoading() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {[0, 1, 2, 4].map((i) => (
        <div key={i} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-5 space-y-4 animate-pulse">
          <div className="h-5 w-24 rounded bg-white/10" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="space-y-2">
              <div className="h-3 w-32 rounded bg-white/10" />
              <div className="h-9 w-full rounded bg-white/10" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ResourceEditor({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useQuery<ClusterSettingsResponse, Error>({
    queryKey: ["cluster", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/settings");
      const payload = (await res.json()) as ClusterSettingsResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to load settings");
      return payload;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return <ResourceEditorLoading />;

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
          <div>
            <p className="font-medium text-white">Unable to load resource settings</p>
            <p className="mt-1 text-red-200/80">{error.message}</p>
            <button
              onClick={() => void refetch()}
              className="mt-3 inline-flex min-h-[38px] items-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 text-sm font-medium text-red-100 hover:bg-red-500/20"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const dataVersion = Object.entries(data.files)
    .sort()
    .map(([f, s]) => `${f}:${s}`)
    .join("|");

  return <ResourceEditorContent key={dataVersion} data={data} canWrite={canWrite} />;
}

// ── Main Panel ──────────────────────────────────────────────────────────────────

export function ClusterSettingsPanel({ embedded = false }: { embedded?: boolean }) {
  const { can } = useRBAC();
  const canWrite = can("config:write");
  const [savedBanner, setSavedBanner] = useState(false);

  // Show banner briefly if just saved
  useEffect(() => {
    if (savedBanner) {
      const t = setTimeout(() => setSavedBanner(false), 4000);
      return () => clearTimeout(t);
    }
  }, [savedBanner]);

  const content = (
    <>
      {savedBanner && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <p className="text-sm text-emerald-200">Changes committed — ArgoCD rolling update triggered.</p>
        </motion.div>
      )}

      <NodeOverview />
      <NodeSpecsEditor canWrite={canWrite} />
      <ResourceEditor canWrite={canWrite} />
    </>
  );

  if (embedded) {
    return <div className="space-y-8">{content}</div>;
  }

  return <div className="max-w-screen-xl space-y-8">{content}</div>;
}
