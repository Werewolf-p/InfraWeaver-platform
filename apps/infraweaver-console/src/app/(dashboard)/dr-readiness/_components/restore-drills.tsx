"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { History, ShieldCheck } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useApiQuery } from "@/hooks/use-api-query";
import { toast } from "@/lib/notify";
import type { DrillEntry, DrillOutcome } from "@/lib/dr/drill-analysis";

interface DrillsResponse {
  entries: DrillEntry[];
  daysSinceLastVerifiedRestore: number | null;
}

const OUTCOMES: DrillOutcome[] = ["verified", "failed", "unverified"];

export function RestoreDrills() {
  const queryClient = useQueryClient();
  const { data } = useApiQuery<DrillsResponse>({ queryKey: ["storage", "dr-drills"], path: "/api/storage/dr/drills", staleTime: 60_000 });

  const [volumeName, setVolumeName] = useState("");
  const [outcome, setOutcome] = useState<DrillOutcome>("verified");
  const [note, setNote] = useState("");

  const logDrill = useMutation({
    mutationFn: () => apiClient.post("/api/storage/dr/drills", { json: { volumeName: volumeName.trim(), outcome, note: note.trim() || undefined } }),
    onSuccess: () => {
      toast.success("Restore drill logged");
      setVolumeName("");
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["storage", "dr-drills"] });
    },
    onError: () => toast.error("Failed to log drill"),
  });

  const days = data?.daysSinceLastVerifiedRestore ?? null;
  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-slate-100 p-4 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-slate-400" />
        <span className="text-sm font-semibold text-gray-900 dark:text-white">Restore drills</span>
        <span className={days === null ? "text-xs text-red-400" : days > 90 ? "text-xs text-yellow-400" : "text-xs text-green-400"}>
          {days === null ? "never verified" : `last verified ${days}d ago`}
        </span>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (volumeName.trim()) logDrill.mutate();
        }}
      >
        <input
          value={volumeName}
          onChange={(e) => setVolumeName(e.target.value)}
          placeholder="volume / PVC name"
          className="min-w-48 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-white/10 dark:bg-slate-800 dark:text-white"
        />
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as DrillOutcome)} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-white/10 dark:bg-slate-800 dark:text-white">
          {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="min-w-40 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-white/10 dark:bg-slate-800 dark:text-white" />
        <button type="submit" disabled={!volumeName.trim() || logDrill.isPending} className="rounded-lg bg-indigo-500/20 px-3 py-1.5 text-xs font-medium text-indigo-300 disabled:opacity-50">Log drill</button>
      </form>

      {entries.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
          {entries.slice(0, 5).map((entry) => (
            <li key={entry.id} className="flex items-center gap-2">
              <History className="h-3 w-3 shrink-0" />
              <span className="font-mono text-slate-600 dark:text-slate-300">{entry.volumeName}</span>
              <span className={entry.outcome === "verified" ? "text-green-400" : entry.outcome === "failed" ? "text-red-400" : "text-slate-400"}>{entry.outcome}</span>
              <span className="truncate">· {entry.verifiedBy}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
