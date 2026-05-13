"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface ArgoApp {
  metadata: { name: string };
  status: {
    health: { status: string };
    sync: { status: string };
    operationState?: { phase?: string };
  };
  spec?: { source?: { repoURL?: string; path?: string } };
}

function healthColor(status: string) {
  if (status === "Healthy") return "bg-green-500/20 border-green-500/30 text-green-400";
  if (status === "Degraded") return "bg-red-500/20 border-red-500/30 text-red-400";
  if (status === "Progressing") return "bg-yellow-500/20 border-yellow-500/30 text-yellow-400";
  return "bg-slate-500/20 border-slate-500/30 text-slate-400";
}

export default function AppGraphPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["argocd", "apps"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ArgoApp[]>;
    },
  });

  const apps = data ?? [];
  const selectedApp = apps.find(a => a.metadata.name === selected);

  if (isLoading) return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{[...Array(9)].map((_, i) => <div key={i} className="h-24 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Network} title="Application Graph" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Network className="w-5 h-5 text-slate-400" />App Dependency Graph</h2>
        <p className="text-sm text-slate-400">ArgoCD application health overview</p>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {apps.map(app => (
              <button
                key={app.metadata.name}
                onClick={() => setSelected(app.metadata.name === selected ? null : app.metadata.name)}
                className={cn("p-3 rounded-xl border text-left transition-all hover:scale-105", selected === app.metadata.name ? "ring-2 ring-indigo-500/50" : "", healthColor(app.status.health.status))}
              >
                <p className="text-xs font-semibold truncate">{app.metadata.name}</p>
                <p className="text-[10px] mt-1 opacity-70">{app.status.health.status}</p>
                <p className="text-[10px] opacity-60">{app.status.sync.status}</p>
              </button>
            ))}
          </div>
          {apps.length === 0 && <p className="text-slate-500 text-sm text-center py-8">No apps found</p>}
        </div>
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          {!selected ? (
            <p className="text-slate-500 text-sm">Click an app node to see details</p>
          ) : selectedApp ? (
            <div className="space-y-3">
              <h3 className="text-lg font-bold text-white">{selectedApp.metadata.name}</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between px-3 py-2 bg-white/5 rounded-lg">
                  <span className="text-xs text-slate-400">Health</span>
                  <span className={cn("text-xs font-semibold", selectedApp.status.health.status === "Healthy" ? "text-green-400" : "text-red-400")}>{selectedApp.status.health.status}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 bg-white/5 rounded-lg">
                  <span className="text-xs text-slate-400">Sync</span>
                  <span className={cn("text-xs font-semibold", selectedApp.status.sync.status === "Synced" ? "text-green-400" : "text-yellow-400")}>{selectedApp.status.sync.status}</span>
                </div>
                {selectedApp.spec?.source?.repoURL && (
                  <div className="px-3 py-2 bg-white/5 rounded-lg">
                    <p className="text-xs text-slate-400 mb-0.5">Repository</p>
                    <p className="text-xs text-slate-300 truncate">{selectedApp.spec.source.repoURL}</p>
                  </div>
                )}
                {selectedApp.spec?.source?.path && (
                  <div className="px-3 py-2 bg-white/5 rounded-lg">
                    <p className="text-xs text-slate-400 mb-0.5">Path</p>
                    <p className="text-xs text-slate-300">{selectedApp.spec.source.path}</p>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
