"use client";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { CheckCircle2, GitBranch, Layers, Minus, Plus, PencilLine } from "lucide-react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { DataError } from "@/components/ui/data-error";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { SkeletonRow } from "@/components/ui/skeleton-row";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import type { KubernetesPod as Pod } from "@/types/kubernetes";

type DiffStatus = "added" | "removed" | "changed" | "unchanged";

interface DiffRow {
  key: string;
  a?: string;
  b?: string;
  status: DiffStatus;
}

interface DiffResult {
  rows: DiffRow[];
  differences: number;
  labelA: string;
  labelB: string;
}

const NOISY_SEGMENTS = new Set([
  "status",
  "managedFields",
  "resourceVersion",
  "uid",
  "generation",
  "creationTimestamp",
  "observedGeneration",
  "selfLink",
]);

function isNoisyPath(path: string): boolean {
  const segments = path.split(/[.[]/).map((segment) => segment.replace(/\]$/, ""));
  if (segments.some((segment) => NOISY_SEGMENTS.has(segment))) return true;
  return path.includes("last-applied-configuration");
}

function flattenDeployment(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenDeployment(item, `${prefix}[${index}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isNoisyPath(path)) continue;
      flattenDeployment(nested, path, out);
    }
    return;
  }
  out[prefix] = String(value);
}

function computeDiff(depA: unknown, depB: unknown, labelA: string, labelB: string): DiffResult {
  const flatA: Record<string, string> = {};
  const flatB: Record<string, string> = {};
  flattenDeployment(depA, "", flatA);
  flattenDeployment(depB, "", flatB);

  const keys = Array.from(new Set([...Object.keys(flatA), ...Object.keys(flatB)])).sort();
  let differences = 0;
  const rows: DiffRow[] = keys.map((key) => {
    const a = flatA[key];
    const b = flatB[key];
    let status: DiffStatus;
    if (a === undefined) status = "added";
    else if (b === undefined) status = "removed";
    else if (a !== b) status = "changed";
    else status = "unchanged";
    if (status !== "unchanged") differences += 1;
    return { key, a, b, status };
  });

  return { rows, differences, labelA, labelB };
}

/** Best-effort Deployment name for a pod, from its ReplicaSet owner or a pod-name heuristic. */
function deriveDeploymentName(pod: Pod): string | null {
  const replicaSet = pod.ownerReferences?.find((owner) => owner.kind === "ReplicaSet");
  if (replicaSet?.name) return replicaSet.name.replace(/-[^-]+$/, "");
  const deployment = pod.ownerReferences?.find((owner) => owner.kind === "Deployment");
  if (deployment?.name) return deployment.name;
  const match = /^(.*)-[a-z0-9]{5,10}-[a-z0-9]{5}$/.exec(pod.name);
  return match ? match[1] : null;
}

const STATUS_STYLES: Record<DiffStatus, { row: string; icon: typeof Plus; iconClass: string; label: string }> = {
  added: { row: "bg-emerald-500/5", icon: Plus, iconClass: "text-emerald-500", label: "Added" },
  removed: { row: "bg-red-500/5", icon: Minus, iconClass: "text-red-500", label: "Removed" },
  changed: { row: "bg-amber-500/5", icon: PencilLine, iconClass: "text-amber-500", label: "Changed" },
  unchanged: { row: "", icon: CheckCircle2, iconClass: "text-slate-400", label: "Unchanged" },
};

function DiffValue({ value, tone }: { value?: string; tone?: "removed" | "added" }) {
  if (value === undefined) return <span className="text-slate-400">—</span>;
  return (
    <span className={cn("font-mono text-xs break-all", tone === "removed" && "text-red-500 dark:text-red-300", tone === "added" && "text-emerald-600 dark:text-emerald-300")}>
      {value}
    </span>
  );
}

function DiffTable({ rows, labelA, labelB }: { rows: DiffRow[]; labelA: string; labelB: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2 text-left font-semibold">Field</th>
            <th className="px-3 py-2 text-left font-semibold">{labelA}</th>
            <th className="px-3 py-2 text-left font-semibold">{labelB}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const style = STATUS_STYLES[row.status];
            const Icon = style.icon;
            return (
              <tr key={row.key} className={cn("border-b border-gray-100 dark:border-white/5 align-top", style.row)}>
                <td className="px-3 py-2">
                  <span className="flex items-start gap-1.5">
                    <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", style.iconClass)} aria-label={style.label} />
                    <span className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">{row.key}</span>
                  </span>
                </td>
                <td className="px-3 py-2"><DiffValue value={row.a} tone={row.status === "changed" || row.status === "removed" ? "removed" : undefined} /></td>
                <td className="px-3 py-2"><DiffValue value={row.b} tone={row.status === "changed" || row.status === "added" ? "added" : undefined} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SidePickerProps {
  title: string;
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (value: string) => void;
  deployment: string;
  onDeploymentChange: (value: string) => void;
  deploymentOptions: string[];
}

function SidePicker({ title, namespaces, namespace, onNamespaceChange, deployment, onDeploymentChange, deploymentOptions }: SidePickerProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Namespace</span>
        {namespaces.length > 0 ? (
          <Select value={namespace} onChange={(event) => onNamespaceChange(event.target.value)} selectSize="sm">
            <option value="">Select namespace…</option>
            {!namespaces.includes(namespace) && namespace ? <option value={namespace}>{namespace}</option> : null}
            {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
          </Select>
        ) : (
          <input
            value={namespace}
            onChange={(event) => onNamespaceChange(event.target.value)}
            placeholder="default"
            className="min-h-[40px] rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
          />
        )}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Deployment</span>
        {deploymentOptions.length > 0 ? (
          <Select value={deployment} onChange={(event) => onDeploymentChange(event.target.value)} selectSize="sm">
            <option value="">Select deployment…</option>
            {deploymentOptions.map((dep) => <option key={dep} value={dep}>{dep}</option>)}
          </Select>
        ) : (
          <input
            value={deployment}
            onChange={(event) => onDeploymentChange(event.target.value)}
            placeholder="deployment name"
            className="min-h-[40px] rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none placeholder:text-slate-500 focus:border-indigo-500/50"
          />
        )}
      </label>
    </div>
  );
}

export default function DeploymentComparePage() {
  const { data: podsData } = useApiQuery<Pod[]>({ queryKey: ["pods"], path: "/api/pods" });
  const pods = useMemo(() => podsData ?? [], [podsData]);

  const deploymentsByNs = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const pod of pods) {
      const dep = deriveDeploymentName(pod);
      if (!dep) continue;
      const set = map.get(pod.namespace) ?? new Set<string>();
      set.add(dep);
      map.set(pod.namespace, set);
    }
    return map;
  }, [pods]);

  const namespaces = useMemo(() => [...deploymentsByNs.keys()].sort(), [deploymentsByNs]);
  const deploymentOptionsFor = (ns: string) => [...(deploymentsByNs.get(ns) ?? new Set<string>())].sort();

  const [nsA, setNsA] = useState("");
  const [depA, setDepA] = useState("");
  const [nsB, setNsB] = useState("");
  const [depB, setDepB] = useState("");
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveNsA = nsA || namespaces[0] || "";
  const effectiveNsB = nsB || namespaces[0] || "";

  const handleCompare = async () => {
    if (!depA || !depB) {
      setError("Select a deployment on both sides before comparing.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cluster/deployment-diff?ns1=${encodeURIComponent(effectiveNsA)}&dep1=${encodeURIComponent(depA)}&ns2=${encodeURIComponent(effectiveNsB)}&dep2=${encodeURIComponent(depB)}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json() as { dep1: unknown; dep2: unknown };
      setResult(computeDiff(data.dep1, data.dep2, `${effectiveNsA}/${depA}`, `${effectiveNsB}/${depB}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const changedRows = useMemo(() => result?.rows.filter((row) => row.status !== "unchanged") ?? [], [result]);
  const unchangedRows = useMemo(() => result?.rows.filter((row) => row.status === "unchanged") ?? [], [result]);
  const canCompare = Boolean(depA && depB) && !loading;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Layers} title="Deployment Compare" />
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white">
          <GitBranch className="h-5 w-5 text-slate-500 dark:text-slate-400" />
          Deployment Comparison
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Compare two deployments field-by-field and highlight what changed</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4 backdrop-blur-sm">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <SidePicker title="Deployment A" namespaces={namespaces} namespace={effectiveNsA} onNamespaceChange={(value) => { setNsA(value); setDepA(""); }} deployment={depA} onDeploymentChange={setDepA} deploymentOptions={deploymentOptionsFor(effectiveNsA)} />
          <SidePicker title="Deployment B" namespaces={namespaces} namespace={effectiveNsB} onNamespaceChange={(value) => { setNsB(value); setDepB(""); }} deployment={depB} onDeploymentChange={setDepB} deploymentOptions={deploymentOptionsFor(effectiveNsB)} />
        </div>
        <button
          onClick={() => void handleCompare()}
          disabled={!canCompare}
          className="mt-4 w-full rounded-lg border border-indigo-500/30 bg-indigo-500/20 py-2 text-sm text-indigo-600 dark:text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
        >
          {loading ? "Comparing…" : "Compare"}
        </button>
      </div>

      {loading && (
        <div className="space-y-2 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          {[...Array(6)].map((_, i) => <SkeletonRow key={i} />)}
        </div>
      )}

      {!loading && error && (
        <DataError message="Deployment comparison failed" detail={error} onRetry={depA && depB ? () => void handleCompare() : undefined} />
      )}

      {!loading && !error && result && (
        <div className="space-y-4">
          <div className={cn(
            "flex flex-wrap items-center gap-3 rounded-xl border p-4",
            result.differences === 0
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-amber-500/30 bg-amber-500/10",
          )}>
            {result.differences === 0 ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-200">Identical — no differences across compared fields.</p>
              </>
            ) : (
              <>
                <PencilLine className="h-5 w-5 text-amber-500" />
                <p className="text-sm font-semibold text-amber-700 dark:text-amber-200">{result.differences} difference{result.differences === 1 ? "" : "s"} found</p>
              </>
            )}
            <span className="ml-auto text-xs text-slate-600 dark:text-slate-400">{result.labelA} vs {result.labelB}</span>
          </div>

          {changedRows.length > 0 && (
            <DiffTable rows={changedRows} labelA={result.labelA} labelB={result.labelB} />
          )}

          {unchangedRows.length > 0 && (
            <CollapsibleSection title="Unchanged fields" count={unchangedRows.length} defaultOpen={false} storageKey="deployment-compare-unchanged">
              <div className="pt-2">
                <DiffTable rows={unchangedRows} labelA={result.labelA} labelB={result.labelB} />
              </div>
            </CollapsibleSection>
          )}
        </div>
      )}

      {!loading && !error && !result && (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 p-10 text-center text-sm text-slate-500">
          Pick a deployment on each side, then run Compare to see a field-level diff.
        </div>
      )}
    </motion.div>
  );
}
