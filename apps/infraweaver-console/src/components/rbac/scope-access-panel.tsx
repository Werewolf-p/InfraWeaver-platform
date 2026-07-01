"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerDownRight, Loader2, MapPin, ShieldBan, User, Users } from "lucide-react";
import { ROLE_COLOR_CLASSES, STATIC_SCOPES } from "@/lib/rbac";
import type { ScopeAccessEntry } from "@/lib/rbac-access-matrix";

interface ScopeAccessResponse {
  scope: string;
  scopeLabel: string;
  entries: ScopeAccessEntry[];
}

function EntryRow({ entry }: { entry: ScopeAccessEntry }) {
  const colors = ROLE_COLOR_CLASSES[entry.color] ?? ROLE_COLOR_CLASSES.gray;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-3 py-2 dark:border-white/5">
      {entry.principalType === "group" ? <Users className="h-3.5 w-3.5 text-indigo-400" /> : <User className="h-3.5 w-3.5 text-slate-400" />}
      <span className="text-xs font-medium text-gray-900 dark:text-[#f2f2f2]">{entry.displayName}</span>
      <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${colors.badge} ${entry.effect === "Deny" ? "!bg-red-500/15 !border-red-500/40 !text-red-300 line-through" : ""}`}>
        {entry.effect === "Deny" && <ShieldBan className="mr-1 inline h-2.5 w-2.5" />}
        {entry.roleName}
      </span>
      {entry.inherited ? (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
          <CornerDownRight className="h-3 w-3" /> inherited from {entry.sourceScopeLabel}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
          <MapPin className="h-3 w-3" /> assigned here
        </span>
      )}
      <span className="text-[10px] text-slate-400">{entry.source}</span>
      {entry.expiresAt && <span className="text-[10px] text-slate-400">· expires {new Date(entry.expiresAt).toLocaleDateString()}</span>}
    </div>
  );
}

export function ScopeAccessPanel() {
  const [scope, setScope] = useState("/");

  const { data, isLoading } = useQuery<ScopeAccessResponse>({
    queryKey: ["rbac", "scope-access", scope],
    queryFn: async () => {
      const res = await fetch(`/api/rbac/scope-access?scope=${encodeURIComponent(scope)}`);
      if (!res.ok) throw new Error("Failed to load scope access");
      return res.json();
    },
  });

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">Scope</label>
        <input
          list="scope-options"
          value={scope}
          onChange={(e) => setScope(e.target.value || "/")}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
        />
        <datalist id="scope-options">
          {STATIC_SCOPES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </datalist>
        <p className="mt-1 text-[11px] text-slate-400">Pick a scope to see every principal with direct or inherited access there.</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/10">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Access on {data?.scopeLabel ?? scope}
        </div>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
        ) : (data?.entries.length ?? 0) === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-slate-400">No principals have access on this scope.</div>
        ) : (
          data?.entries.map((entry, i) => <EntryRow key={`${entry.principalId}-${entry.roleId}-${i}`} entry={entry} />)
        )}
      </div>
    </div>
  );
}
