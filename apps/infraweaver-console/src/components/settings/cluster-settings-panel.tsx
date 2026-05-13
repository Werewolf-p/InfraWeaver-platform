"use client";

import { motion } from "framer-motion";
import { Boxes, Download, GitBranch, Link2, Server, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CopyButton } from "@/components/ui/copy-button";
import { SkeletonCard } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";

interface ClusterNode {
  name: string;
  version?: string;
}

export function ClusterSettingsPanel() {
  const { data, isLoading } = useQuery<{ nodes: ClusterNode[] }>({
    queryKey: ["cluster", "nodes"],
    queryFn: async () => {
      const response = await fetch("/api/cluster/nodes");
      return response.json();
    },
    staleTime: 60000,
  });

  const clusterName = "talos-prod";
  const argoCdUrl = "http://argocd-server.argocd.svc.cluster.local";
  const nodeCount = data?.nodes?.length ?? 0;
  const version = data?.nodes?.[0]?.version ?? "Unknown";
  const detailRows = [
    { label: "Cluster Name", value: clusterName },
    { label: "Nodes", value: String(nodeCount || "—") },
    { label: "Kubernetes Version", value: version },
    { label: "ArgoCD URL", value: argoCdUrl },
  ];

  const metricCards = [
    {
      title: "Cluster",
      description: "Active environment",
      value: clusterName,
      meta: "Talos-managed control plane",
      icon: Server,
      accent: "bg-[#3b82f6]/15 text-[#60a5fa]",
    },
    {
      title: "Nodes",
      description: "Discovered worker capacity",
      value: nodeCount ? String(nodeCount) : "—",
      meta: nodeCount === 1 ? "1 registered node" : `${nodeCount} registered nodes`,
      icon: Boxes,
      accent: "bg-emerald-500/15 text-emerald-400",
    },
    {
      title: "Kubernetes",
      description: "Primary API version",
      value: version,
      meta: "Synced from node inventory",
      icon: GitBranch,
      accent: "bg-violet-500/15 text-violet-300",
    },
  ];

  const exportClusterInfo = () => {
    const info = JSON.stringify({ clusterName, argoCdUrl, nodeCount, version }, null, 2);
    const blob = new Blob([info], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cluster-info.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Cluster info exported");
  };

  return (
    <div className="max-w-screen-xl space-y-6">
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {metricCards.map(({ title, description, value, meta, icon: Icon, accent }, index) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="rounded-xl border border-[#2a2a2a] bg-[#111] p-5"
            >
              <div className="flex items-start gap-3">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${accent}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[#f2f2f2]">{title}</p>
                  <p className="mt-1 text-xs text-[#888]">{description}</p>
                </div>
              </div>
              <p className="mt-5 truncate font-mono text-lg font-semibold tabular-nums text-[#f2f2f2]">{value}</p>
              <p className="mt-1 text-xs text-[#888]">{meta}</p>
            </motion.div>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3b82f6]/15 text-[#60a5fa]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-[#f2f2f2]">Infrastructure overview</p>
              <p className="mt-1 text-sm text-[#888]">Azure, AWS, and GCP consoles surface critical identifiers with inline copy affordances. InfraWeaver now does the same.</p>
            </div>
            <StatusBadge status="healthy" label="Read only" size="sm" showIcon />
          </div>
          <div className="mt-5 space-y-3">
            {detailRows.map((row) => (
              <div key={row.label} className="group flex items-center justify-between gap-3 rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-[#888]">{row.label}</p>
                  <p className="mt-1 truncate font-mono text-sm text-[#f2f2f2]">{row.value}</p>
                </div>
                <CopyButton text={row.value} label="Copy" className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-base font-medium text-[#f2f2f2]">Operator actions</p>
              <p className="mt-1 text-sm text-[#888]">Primary export action with copyable endpoints mirrors AWS-style action hierarchy.</p>
            </div>
          </div>
          <div className="mt-5 rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-4">
            <p className="text-xs uppercase tracking-wider text-[#888]">Control plane endpoint</p>
            <p className="mt-1 truncate font-mono text-sm text-[#f2f2f2]">{argoCdUrl}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <CopyButton text={argoCdUrl} label="Copy URL" />
              <button
                onClick={exportClusterInfo}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#3b82f6] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
              >
                <Download className="h-3.5 w-3.5" />
                Export JSON
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
