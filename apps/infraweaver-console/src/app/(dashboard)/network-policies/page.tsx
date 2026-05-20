"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Network, Shield} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

interface NetworkPolicy {
  namespace: string;
  name: string;
  podSelector: unknown;
  ingressRules: number;
  egressRules: number;
  policyTypes: string[];
  createdAt: string;
}

export default function NetworkPoliciesPage() {
  const [nsFilter, setNsFilter] = useState("all");
  const [showYaml, setShowYaml] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["network", "policies"],
    queryFn: async () => {
      const res = await fetch("/api/network/policies");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ policies: NetworkPolicy[] }>;
    },
  });

  const policies = data?.policies ?? [];
  const namespaces = ["all", ...new Set(policies.map(p => p.namespace))];
  const filtered = nsFilter === "all" ? policies : policies.filter(p => p.namespace === nsFilter);

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Shield} title="Network Policies" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Network className="w-5 h-5 text-slate-500 dark:text-slate-400" />Network Policies</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Kubernetes NetworkPolicy resources</p>
        </div>
        <select value={nsFilter} onChange={e => setNsFilter(e.target.value)} className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50">
          {namespaces.map(ns => <option key={ns} value={ns}>{ns === "all" ? "All namespaces" : ns}</option>)}
        </select>
      </div>
      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-gray-200 dark:border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Name</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Namespace</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Ingress Rules</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Egress Rules</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Types</th>
            <th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {filtered.map(p => (
              <>
                <tr key={p.name} className="border-b border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{p.namespace}</td>
                  <td className="px-4 py-3 text-sm text-center text-slate-700 dark:text-slate-300">{p.ingressRules}</td>
                  <td className="px-4 py-3 text-sm text-center text-slate-700 dark:text-slate-300">{p.egressRules}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">{p.policyTypes.map(t => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400">{t}</span>)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => setShowYaml(showYaml === p.name ? null : p.name)} className="text-xs text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                      {showYaml === p.name ? "Hide" : "YAML"}
                    </button>
                  </td>
                </tr>
                {showYaml === p.name && (
                  <tr key={`${p.name}-yaml`} className="border-b border-gray-200 dark:border-white/5">
                    <td colSpan={6} className="px-4 pb-4">
                      <pre className="bg-black/40 rounded-lg p-3 text-xs text-green-300">{JSON.stringify({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: p.name, namespace: p.namespace }, spec: { podSelector: p.podSelector, policyTypes: p.policyTypes } }, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No network policies found</div>}
      </div>
    </motion.div>
  );
}
