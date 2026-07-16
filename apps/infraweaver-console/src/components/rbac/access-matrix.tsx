"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, Loader2, Search, ShieldAlert, ShieldBan, ServerCog, User, Users } from "lucide-react";
import {
  GROUP_DENIED_PERMISSIONS,
  ROLE_COLOR_CLASSES,
  ROOT_SCOPE,
  expandToConcrete,
  isStrictAncestorScope,
  resolveRoleDefinition,
  scopeCovers,
  scopeLabel,
} from "@/lib/rbac";
import { ExportButton } from "@/components/ui/export-button";
import type { AccessMatrix, AccessMatrixCell, AccessMatrixPrincipal } from "@/lib/rbac-access-matrix";

function colorClasses(color: AccessMatrixCell["color"]) {
  return ROLE_COLOR_CLASSES[color] ?? ROLE_COLOR_CLASSES.gray;
}

const ESCALATION_PERMISSIONS = new Set<string>(GROUP_DENIED_PERMISSIONS.filter((permission) => permission !== "*"));

/** A grant that confers platform-escalation permissions (admin/owner tier). */
function isAdminTierRole(roleId: string): boolean {
  const role = resolveRoleDefinition(roleId);
  if (!role) return /(^|[-:])(admin|owner)$/i.test(roleId);
  if (role.permissions.includes("*")) return true;
  return role.permissions.flatMap((pattern) => expandToConcrete(pattern)).some((permission) => ESCALATION_PERMISSIONS.has(permission));
}

type PostureFilter = "cluster" | "admin" | "deny" | "expiring" | "orphaned";

const POSTURE_PREDICATES: Record<PostureFilter, (cell: AccessMatrixCell) => boolean> = {
  cluster: (cell) => cell.scope === ROOT_SCOPE,
  admin: (cell) => isAdminTierRole(cell.roleId),
  deny: (cell) => cell.effect === "Deny",
  expiring: (cell) => cell.expiringSoon,
  orphaned: (cell) => cell.orphaned,
};

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const EXPORT_HEADERS = ["principal", "type", "secondary", "role", "roleId", "scope", "scopeLabel", "effect", "expiresAt", "source", "orphaned", "expiringSoon"] as const;

interface ExportRow {
  principal: string;
  type: string;
  secondary: string;
  role: string;
  roleId: string;
  scope: string;
  scopeLabel: string;
  effect: string;
  expiresAt: string;
  source: string;
  orphaned: boolean;
  expiringSoon: boolean;
}

function toExportRows(principals: AccessMatrixPrincipal[]): ExportRow[] {
  return principals.flatMap((principal) =>
    principal.cells.map((cell) => ({
      principal: principal.displayName,
      type: principal.principalType,
      secondary: principal.secondary ?? "",
      role: cell.roleName,
      roleId: cell.roleId,
      scope: cell.scope,
      scopeLabel: cell.scopeLabel,
      effect: cell.effect,
      expiresAt: cell.expiresAt ?? "",
      source: cell.source,
      orphaned: cell.orphaned,
      expiringSoon: cell.expiringSoon,
    })),
  );
}

/** Grants of a principal that are EFFECTIVE at a column scope (direct + inherited). */
function cellsForScope(principal: AccessMatrixPrincipal, scope: string): AccessMatrixCell[] {
  return principal.cells.filter((cell) => scopeCovers(cell.scope, scope));
}

function CellBadge({ cell, scope }: { cell: AccessMatrixCell; scope: string }) {
  const inherited = isStrictAncestorScope(cell.scope, scope);
  const colors = colorClasses(cell.color);
  const title = `${cell.roleName} — ${cell.source}${inherited ? ` (inherited from ${cell.scopeLabel})` : ""}${cell.expiresAt ? ` · expires ${new Date(cell.expiresAt).toLocaleString()}` : ""}`;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${colors.badge} ${inherited ? "border-dashed opacity-70" : ""} ${cell.effect === "Deny" ? "!bg-red-500/15 !border-red-500/40 !text-red-300 line-through" : ""} ${cell.orphaned ? "!border-red-500/50 !text-red-300" : ""}`}
    >
      {cell.effect === "Deny" && <ShieldBan className="h-2.5 w-2.5" />}
      {cell.orphaned && <AlertTriangle className="h-2.5 w-2.5" />}
      {cell.expiringSoon && <Clock className="h-2.5 w-2.5" />}
      {cell.roleName}
    </span>
  );
}

export function AccessMatrix() {
  const [search, setSearch] = useState("");
  const [posture, setPosture] = useState<PostureFilter | null>(null);

  const { data, isLoading, error } = useQuery<AccessMatrix>({
    queryKey: ["rbac", "access-matrix"],
    queryFn: async () => {
      const res = await fetch("/api/rbac/access-matrix");
      if (!res.ok) throw new Error("Failed to load access matrix");
      return res.json();
    },
  });

  const scopes = data?.scopes ?? [];
  const query = search.trim().toLowerCase();

  const summary = useMemo(() => {
    const counts: Record<PostureFilter, number> = { cluster: 0, admin: 0, deny: 0, expiring: 0, orphaned: 0 };
    for (const principal of data?.principals ?? []) {
      for (const cell of principal.cells) {
        for (const key of Object.keys(counts) as PostureFilter[]) {
          if (POSTURE_PREDICATES[key](cell)) counts[key] += 1;
        }
      }
    }
    return counts;
  }, [data?.principals]);

  const principals = useMemo(() => {
    const rows = data?.principals ?? [];
    const matchesPosture = posture ? POSTURE_PREDICATES[posture] : null;
    return rows.filter((principal) => {
      if (matchesPosture && !principal.cells.some(matchesPosture)) return false;
      if (!query) return true;
      if (principal.displayName.toLowerCase().includes(query)) return true;
      if (principal.secondary?.toLowerCase().includes(query)) return true;
      if (principal.cells.some((cell) => cell.roleName.toLowerCase().includes(query) || cell.scopeLabel.toLowerCase().includes(query))) return true;
      return false;
    });
  }, [data?.principals, query, posture]);

  const exportMatrix = (format: "csv" | "json") => {
    const rows = toExportRows(principals);
    if (format === "json") return JSON.stringify(rows, null, 2);
    const header = EXPORT_HEADERS.join(",");
    const lines = rows.map((row) => EXPORT_HEADERS.map((key) => csvField(String(row[key]))).join(","));
    return [header, ...lines].join("\n");
  };

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  if (error) return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">Failed to load the access matrix.</div>;

  const summaryChips: Array<{ key: PostureFilter; label: string; count: number; icon: typeof ServerCog; tone: string }> = [
    { key: "cluster", label: "Cluster-wide", count: summary.cluster, icon: ServerCog, tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
    { key: "admin", label: "Admin-tier", count: summary.admin, icon: ShieldAlert, tone: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300" },
    { key: "deny", label: "Deny rules", count: summary.deny, icon: ShieldBan, tone: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300" },
    { key: "expiring", label: "Expiring soon", count: summary.expiring, icon: Clock, tone: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300" },
    { key: "orphaned", label: "Orphaned", count: summary.orphaned, icon: AlertTriangle, tone: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {summaryChips.map((chip) => {
          const active = posture === chip.key;
          const Icon = chip.icon;
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setPosture((current) => (current === chip.key ? null : chip.key))}
              aria-pressed={active}
              disabled={chip.count === 0 && !active}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${chip.tone} ${active ? "ring-2 ring-offset-1 ring-current ring-offset-white dark:ring-offset-[#0d0d0d]" : "hover:brightness-110"}`}
            >
              <Icon className="h-3 w-3" />
              {chip.label}
              <span className="rounded-full bg-black/10 px-1.5 dark:bg-white/15">{chip.count}</span>
            </button>
          );
        })}
        <div className="ml-auto">
          <ExportButton getData={(format) => exportMatrix(format as "csv" | "json")} filename="access-matrix" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by principal, role, or scope…"
            className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-xs text-gray-900 focus:border-[#0078D4] focus:outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          />
        </div>
        {posture ? (
          <button
            type="button"
            onClick={() => setPosture(null)}
            className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            Clear filter
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-gray-50 dark:bg-white/5">
              <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-[#0d0d0d] dark:text-slate-400">Principal</th>
              {scopes.map((scope) => (
                <th key={scope} className="px-3 py-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400" title={scope}>
                  {scopeLabel(scope)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {principals.map((principal) => (
              <tr key={`${principal.principalType}:${principal.principalId}`} className="border-t border-gray-100 dark:border-white/5">
                <th className="sticky left-0 z-10 bg-white px-3 py-2 align-top dark:bg-[#111]">
                  <div className="flex items-center gap-1.5">
                    {principal.principalType === "group" ? <Users className="h-3.5 w-3.5 text-indigo-400" /> : <User className="h-3.5 w-3.5 text-slate-400" />}
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-gray-900 dark:text-[#f2f2f2]">{principal.displayName}</p>
                      {principal.secondary && <p className="truncate text-[10px] text-slate-400">{principal.secondary}</p>}
                    </div>
                  </div>
                </th>
                {scopes.map((scope) => {
                  const cells = cellsForScope(principal, scope);
                  return (
                    <td key={scope} className="px-3 py-2 align-top">
                      {cells.length === 0 ? (
                        <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {cells.map((cell, i) => (
                            <CellBadge key={`${cell.roleId}-${cell.scope}-${i}`} cell={cell} scope={scope} />
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {principals.length === 0 && (
              <tr>
                <td colSpan={scopes.length + 1} className="px-3 py-8 text-center text-xs text-slate-400">No principals match your filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-400">
        Solid badges are assigned directly on the scope; <span className="rounded border border-dashed border-slate-400 px-1 opacity-70">dashed</span> badges are inherited from a parent scope. <span className="text-red-300">Deny</span> and orphaned grants are highlighted in red.
      </p>
    </div>
  );
}
