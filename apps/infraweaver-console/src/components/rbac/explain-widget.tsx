"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, HelpCircle, Loader2, ShieldBan, XCircle } from "lucide-react";
import { ALL_PERMISSIONS, STATIC_SCOPES, scopeLabel, type Permission, type RoleAssignment } from "@/lib/rbac";
import type { AccessMatrix } from "@/lib/rbac-access-matrix";

interface ExplainResponse {
  principal: string;
  principalType: "user" | "group";
  action: Permission;
  scope: string;
  scopeLabel: string;
  allowed: boolean;
  effect: "Allow" | "Deny" | "NotApplicable";
  decidingAssignments: RoleAssignment[];
}

const ACTIONS: Permission[] = ALL_PERMISSIONS.filter((p) => p !== "*");

export function ExplainWidget() {
  const [principalKey, setPrincipalKey] = useState("");
  const [action, setAction] = useState<Permission>("apps:read");
  const [scope, setScope] = useState("/");

  const matrixQuery = useQuery<AccessMatrix>({
    queryKey: ["rbac", "access-matrix"],
    queryFn: async () => {
      const res = await fetch("/api/rbac/access-matrix");
      if (!res.ok) throw new Error("Failed to load principals");
      return res.json();
    },
  });

  const [principalType, principalId] = principalKey ? (principalKey.split("::") as ["user" | "group", string]) : ["user", ""];

  const explainQuery = useQuery<ExplainResponse>({
    queryKey: ["rbac", "explain", principalKey, action, scope],
    enabled: Boolean(principalId),
    queryFn: async () => {
      const qs = new URLSearchParams({ principal: principalId, principalType, action, scope });
      const res = await fetch(`/api/rbac/explain?${qs.toString()}`);
      if (!res.ok) throw new Error("Failed to explain");
      return res.json();
    },
  });

  const result = explainQuery.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">Principal</span>
          <select
            value={principalKey}
            onChange={(e) => setPrincipalKey(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          >
            <option value="">Select…</option>
            {(matrixQuery.data?.principals ?? []).map((p) => (
              <option key={`${p.principalType}::${p.principalId}`} value={`${p.principalType}::${p.principalId}`}>
                {p.principalType === "group" ? "Group: " : ""}{p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">Action</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as Permission)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          >
            {ACTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">Scope</span>
          <input
            list="explain-scope-options"
            value={scope}
            onChange={(e) => setScope(e.target.value || "/")}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          />
          <datalist id="explain-scope-options">
            {STATIC_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </datalist>
        </label>
      </div>

      {!principalId ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-xs text-slate-400 dark:border-white/10">
          Pick a principal, action, and scope to explain the access decision.
        </div>
      ) : explainQuery.isLoading ? (
        <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
      ) : result ? (
        <div className={`rounded-xl border p-4 ${result.allowed ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
          <div className="flex items-center gap-2">
            {result.allowed ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : result.effect === "Deny" ? <ShieldBan className="h-5 w-5 text-red-400" /> : <XCircle className="h-5 w-5 text-red-400" />}
            <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">
              {result.allowed ? "Allowed" : "Denied"}
              <span className="ml-2 rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500 dark:bg-white/10 dark:text-slate-400">{result.effect}</span>
            </p>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono">{result.action}</span> on <span className="font-mono">{result.scopeLabel}</span>
          </p>
          <div className="mt-3">
            <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <HelpCircle className="h-3 w-3" /> Deciding assignments
            </p>
            {result.decidingAssignments.length === 0 ? (
              <p className="text-xs text-slate-400">
                {result.allowed ? "Granted by a legacy group role or default." : "No assignment grants this action at this scope."}
              </p>
            ) : (
              <ul className="space-y-1">
                {result.decidingAssignments.map((a) => (
                  <li key={a.id} className="text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-mono">{a.roleId}</span> @ <span className="font-mono">{scopeLabel(a.scope)}</span>
                    <span className="ml-1 text-slate-400">({a.effect ?? "Allow"} · {a.grantedBy})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
