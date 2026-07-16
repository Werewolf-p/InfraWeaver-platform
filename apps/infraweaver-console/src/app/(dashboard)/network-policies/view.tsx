"use client";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Network, Search, Shield } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";

interface NetworkPolicy {
  namespace: string;
  name: string;
  podSelector: unknown;
  ingressRules: number;
  egressRules: number;
  policyTypes: string[];
  createdAt: string;
}

type IsolationTone = "deny" | "allow" | "open";

const TONE_CLASS: Record<IsolationTone, string> = {
  deny: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300",
  allow: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  open: "border-slate-300 bg-slate-100 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400",
};

// Turn raw rule counts + policyTypes into a plain-language isolation posture.
function directionSummary(direction: "Ingress" | "Egress", ruleCount: number, policyTypes: string[]): { label: string; tone: IsolationTone } {
  const governs = policyTypes.includes(direction);
  if (!governs) return { label: "not restricted", tone: "open" };
  if (ruleCount === 0) return { label: "default-deny", tone: "deny" };
  return { label: `${ruleCount} allow rule${ruleCount === 1 ? "" : "s"}`, tone: "allow" };
}

// Describe which pods a policy applies to from its podSelector.
function selectorSummary(selector: unknown): string {
  if (!selector || typeof selector !== "object") return "all pods";
  const value = selector as { matchLabels?: Record<string, unknown>; matchExpressions?: unknown[] };
  const labelCount = value.matchLabels ? Object.keys(value.matchLabels).length : 0;
  const exprCount = Array.isArray(value.matchExpressions) ? value.matchExpressions.length : 0;
  if (labelCount === 0 && exprCount === 0) return "all pods";
  const parts: string[] = [];
  if (labelCount) parts.push(`${labelCount} label${labelCount === 1 ? "" : "s"}`);
  if (exprCount) parts.push(`${exprCount} expression${exprCount === 1 ? "" : "s"}`);
  return `pods matching ${parts.join(" + ")}`;
}

function IsolationPill({ direction, ruleCount, policyTypes }: { direction: "Ingress" | "Egress"; ruleCount: number; policyTypes: string[] }) {
  const { label, tone } = directionSummary(direction, ruleCount, policyTypes);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs", TONE_CLASS[tone])}>
      <span className="font-medium">{direction}:</span> {label}
    </span>
  );
}

export function NetworkPoliciesView() {
  const [nsFilter, setNsFilter] = useState("all");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useApiQuery<{ policies: NetworkPolicy[] }>({
    queryKey: ["network", "policies"],
    path: "/api/network/policies",
  });

  const policies = useMemo(() => data?.policies ?? [], [data?.policies]);
  const namespaces = useMemo(() => ["all", ...new Set(policies.map((p) => p.namespace))], [policies]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return policies.filter((p) => {
      const matchesNs = nsFilter === "all" || p.namespace === nsFilter;
      const matchesSearch = !query || `${p.name} ${p.namespace}`.toLowerCase().includes(query);
      return matchesNs && matchesSearch;
    });
  }, [policies, nsFilter, search]);

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Shield} title="Network Policies" subtitle="Kubernetes NetworkPolicy isolation posture per workload" />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by policy name or namespace…"
            className="w-full rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
          />
        </div>
        <select
          value={nsFilter}
          onChange={(e) => setNsFilter(e.target.value)}
          className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
        >
          {namespaces.map((ns) => <option key={ns} value={ns}>{ns === "all" ? "All namespaces" : ns}</option>)}
        </select>
      </div>

      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Policy</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Namespace</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Applies to</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Isolation</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-b border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">
                    <span className="inline-flex items-center gap-2"><Network className="h-3.5 w-3.5 text-slate-400" />{p.name}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{p.namespace}</td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">{selectorSummary(p.podSelector)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <IsolationPill direction="Ingress" ruleCount={p.ingressRules} policyTypes={p.policyTypes} />
                      <IsolationPill direction="Egress" ruleCount={p.egressRules} policyTypes={p.policyTypes} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center text-slate-500 text-sm">
            {policies.length === 0 ? "No network policies found" : "No policies match the current filters"}
          </div>
        )}
      </div>
    </motion.div>
  );
}
