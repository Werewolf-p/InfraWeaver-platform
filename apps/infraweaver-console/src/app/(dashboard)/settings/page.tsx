"use client";
import { motion } from "framer-motion";
import { RefreshCw, Layout, Filter, CheckCircle2, XCircle, Loader2, Server, Copy, Check, Sun, AlignJustify, Zap, Settings } from "lucide-react";
import { useSettingsContext, type RefreshInterval } from "@/contexts/settings-context";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { PageHeader } from "@/components/ui/page-header";
import { DensityToggle } from "@/components/ui/density-toggle";

const REFRESH_OPTIONS: { label: string; value: RefreshInterval }[] = [
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "60s", value: 60000 },
  { label: "5m", value: 300000 },
];

function ConnectionStatus({ label, queryFn }: { label: string; queryFn: () => Promise<unknown> }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["status", label],
    queryFn,
    retry: 1,
    refetchInterval: 60000,
    staleTime: 30000,
  });
  return (
    <div className="flex items-center gap-2">
      {isLoading ? (
        <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
      ) : isError || !data ? (
        <XCircle className="w-3.5 h-3.5 text-red-400" />
      ) : (
        <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
      )}
      <span className={cn("text-xs font-medium", isLoading ? "text-slate-400" : isError ? "text-red-400" : "text-green-400")}>
        {label}: {isLoading ? "Checking..." : isError ? "Disconnected" : "Connected"}
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, updateSetting, mounted } = useSettingsContext();
  const { simpleMode, setSimpleMode } = useSimpleMode();
  const [activeTab, setActiveTab] = useState<"general" | "cluster">("general");

  if (!mounted) {
    return (
      <div className="max-w-2xl space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageHeader icon={Settings} title="Settings" subtitle="Console and platform settings" />

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["general", "cluster"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors",
              activeTab === tab
                ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300"
                : "bg-white/5 border border-white/10 text-slate-400 hover:text-white"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
      <div className="max-w-2xl space-y-4">
        {/* Refresh Interval */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <RefreshCw className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Refresh Interval</p>
              <p className="text-xs text-slate-400">How often to poll cluster data</p>
            </div>
          </div>
          <div className="flex gap-2">
            {REFRESH_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => updateSetting("refreshInterval", opt.value)}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                  settings.refreshInterval === opt.value
                    ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300"
                    : "bg-white/5 border border-white/10 text-slate-400 hover:text-white"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </motion.div>

        {/* Compact Mode */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Layout className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Compact Mode</p>
              <p className="text-xs text-slate-400">Reduce padding in cards for denser view</p>
            </div>
          </div>
          <button
            onClick={() => updateSetting("compactMode", !settings.compactMode)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              settings.compactMode ? "bg-indigo-500" : "bg-slate-700"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform",
                settings.compactMode ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </motion.div>

        {/* Show System Apps */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Filter className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Show System Apps</p>
              <p className="text-xs text-slate-400">Include core-*, bootstrap-*, platform-* in apps view</p>
            </div>
          </div>
          <button
            onClick={() => updateSetting("showSystemApps", !settings.showSystemApps)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              settings.showSystemApps ? "bg-indigo-500" : "bg-slate-700"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform",
                settings.showSystemApps ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </motion.div>

        {/* Theme */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Sun className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Theme</p>
              <p className="text-xs text-slate-400">Light, Dark, or follow System preference</p>
            </div>
          </div>
          <ThemeToggle />
        </motion.div>

        {/* Density */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <AlignJustify className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Display Density</p>
              <p className="text-xs text-slate-400">Control spacing and padding in the UI</p>
            </div>
          </div>
          <DensityToggle />
        </motion.div>

        {/* Simple Mode */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Zap className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Simple Mode</p>
              <p className="text-xs text-slate-400">Hide advanced fields in forms across the console</p>
            </div>
          </div>
          <button
            onClick={() => setSimpleMode(!simpleMode)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              simpleMode ? "bg-indigo-500" : "bg-slate-700"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform",
                simpleMode ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </motion.div>

        {/* Connection Status */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-white/5 border border-white/10 rounded-xl p-5"
        >
          <p className="text-sm font-medium text-white mb-3">Connection Status</p>
          <div className="space-y-2">
            <ConnectionStatus
              label="ArgoCD"
              queryFn={async () => {
                const res = await fetch("/api/argocd/apps");
                if (!res.ok) throw new Error("ArgoCD unreachable");
                return res.json();
              }}
            />
            <ConnectionStatus
              label="GitHub"
              queryFn={async () => {
                const res = await fetch("/api/config/platform");
                if (!res.ok) throw new Error("GitHub unreachable");
                return res.json();
              }}
            />
          </div>
        </motion.div>
      </div>
      )}

      {activeTab === "cluster" && (
        <ClusterTab />
      )}
    </div>
  );
}

function ClipCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="ml-2 text-slate-500 hover:text-slate-300 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function ClusterTab() {
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
          ].map(row => (
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
            const a = document.createElement("a");
            a.href = url;
            a.download = "cluster-info.json";
            a.click();
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
