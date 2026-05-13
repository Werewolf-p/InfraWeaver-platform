"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Copy, Server } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

function ClipCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="ml-2 text-slate-500 hover:text-slate-300 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function ClusterSettingsPanel() {
  const { data } = useQuery<{ nodes: Array<{ name: string; version?: string }> }>({
    queryKey: ["cluster", "nodes"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/nodes");
      return res.json();
    },
    staleTime: 60000,
  });

  const clusterName = "talos-prod";
  const argoCdUrl = "http://argocd-server.argocd.svc.cluster.local";
  const nodeCount = data?.nodes?.length ?? "—";
  const version = data?.nodes?.[0]?.version ?? "—";

  return (
    <div className="max-w-2xl space-y-4">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
            <Server className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Cluster Info</p>
            <p className="text-xs text-slate-400">Read-only cluster configuration</p>
          </div>
        </div>
        <div className="space-y-3">
          {[
            { label: "Cluster Name", value: clusterName },
            { label: "Nodes", value: String(nodeCount) },
            { label: "K8s Version", value: version },
            { label: "ArgoCD URL", value: argoCdUrl },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
              <span className="text-xs text-slate-400">{row.label}</span>
              <div className="flex items-center">
                <span className="text-xs font-mono text-slate-200">{row.value}</span>
                <ClipCopy text={row.value} />
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
        <p className="text-sm font-medium text-white mb-3">Export Cluster Info</p>
        <button
          onClick={() => {
            const info = JSON.stringify({ clusterName, argoCdUrl, nodeCount, version }, null, 2);
            const blob = new Blob([info], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "cluster-info.json";
            anchor.click();
            URL.revokeObjectURL(url);
          }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors"
        >
          Export as JSON
        </button>
      </motion.div>
    </div>
  );
}
