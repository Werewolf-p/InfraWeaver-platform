"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { GitBranch } from "lucide-react";

interface ArgoApp {
  metadata: { name: string };
  status: { health: { status: string }; sync: { status: string } };
}

interface DiffResult {
  diff?: string;
  error?: string;
}

export default function GitopsDiffPage() {
  const [selectedApp, setSelectedApp] = useState<string>("");

  const { data: appsData } = useQuery({
    queryKey: ["argocd", "apps"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ArgoApp[]>;
    },
  });

  const { data: diffData, isLoading } = useQuery({
    queryKey: ["argocd", "diff", selectedApp],
    queryFn: async () => {
      const res = await fetch(`/api/argocd/diff/${selectedApp}`);
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<DiffResult>;
    },
    enabled: !!selectedApp,
  });

  const apps = appsData ?? [];

  const colorLine = (line: string) => {
    if (line.startsWith("+")) return "text-green-400";
    if (line.startsWith("-")) return "text-red-400";
    if (line.startsWith("@@")) return "text-blue-400";
    return "text-slate-300";
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><GitBranch className="w-5 h-5 text-slate-400" />GitOps Diff Viewer</h2>
        <p className="text-sm text-slate-400">View ArgoCD application diffs</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
        <label className="text-xs text-slate-400 mb-2 block">Select Application</label>
        <select value={selectedApp} onChange={e => setSelectedApp(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
          <option value="">Choose an app...</option>
          {apps.map(a => (
            <option key={a.metadata.name} value={a.metadata.name}>
              {a.metadata.name} — {a.status.health.status} / {a.status.sync.status}
            </option>
          ))}
        </select>
      </div>
      {selectedApp && (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Diff: {selectedApp}</h3>
          {isLoading ? (
            <div className="h-32 bg-white/5 rounded-lg animate-pulse" />
          ) : diffData?.error ? (
            <p className="text-sm text-red-400">{diffData.error}</p>
          ) : diffData?.diff ? (
            <pre className="bg-black/40 rounded-lg p-4 text-xs overflow-auto max-h-96">
              {diffData.diff.split("\n").map((line, i) => (
                <span key={i} className={`block ${colorLine(line)}`}>{line}</span>
              ))}
            </pre>
          ) : (
            <p className="text-sm text-green-400">✓ No diff — in sync</p>
          )}
        </div>
      )}
    </motion.div>
  );
}
