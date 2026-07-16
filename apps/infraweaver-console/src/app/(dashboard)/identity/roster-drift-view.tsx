"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, UserX } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { CopyButton } from "@/components/ui/copy-button";
import { OffboardWizard } from "@/components/users/offboard-wizard";
import { useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";
import type { RosterDriftEntry, RosterDriftReport } from "@/lib/security/roster-drift";

type RosterDriftResponse = RosterDriftReport & { ok?: boolean };

const REASON_LABEL: Record<RosterDriftEntry["reasons"][number], string> = {
  unmanaged: "Not in users.yaml",
  "suspicious-name": "Suspicious name",
};

function DriftRow({
  entry,
  canManage,
  onOffboard,
}: {
  entry: RosterDriftEntry;
  canManage: boolean;
  onOffboard: (username: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-white/5 bg-slate-100 dark:bg-slate-950/60 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{entry.username}</p>
          {entry.privileged ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-300">
              <ShieldAlert className="h-3 w-3" />
              Privileged{entry.privilegedVia ? ` · ${entry.privilegedVia}` : ""}
            </span>
          ) : null}
        </div>
        {entry.email ? <p className="mt-0.5 truncate text-xs text-slate-500">{entry.email}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.reasons.map((reason) => (
          <span
            key={reason}
            className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300"
          >
            {REASON_LABEL[reason] ?? reason}
          </span>
        ))}
        <CopyButton text={entry.username} label="Username" className="h-7 px-2" />
        {canManage ? (
          <button
            type="button"
            onClick={() => onOffboard(entry.username)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-300"
          >
            <UserX className="h-3.5 w-3.5" />
            Offboard
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Roster Drift — surfaces the /api/security/roster-drift report (unmanaged and
 * suspicious ACTIVE Authentik accounts that users.yaml does not account for) as a
 * first-class Identity tab, escalating privileged unmanaged accounts.
 */
export function RosterDriftView() {
  const { canAny } = useRBAC();
  const canManage = canAny(["users:write", "users:invite", "rbac:admin"]);
  const [offboardUsername, setOffboardUsername] = useState<string | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useApiQuery<RosterDriftResponse>({
    queryKey: ["security", "roster-drift"],
    path: "/api/security/roster-drift",
    request: { cache: "no-store" },
    staleTime: 30_000,
  });

  const report = data;
  const drift = report?.drift ?? [];
  const privileged = report?.privilegedUnmanaged ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        icon={UserX}
        title="Roster Drift"
        subtitle="ACTIVE Authentik accounts that users.yaml does not account for"
        actions={
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="touch-target inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Rescan
          </button>
        }
      />

      {error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-600 dark:text-red-300">
          Failed to load the roster-drift report. Admin permission (security:read / rbac:admin / cluster:admin) is required.
        </div>
      ) : null}

      {report?.alert ? (
        <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            {privileged.length} unmanaged <strong>privileged</strong> account(s) detected. Review and either add them to
            users.yaml or offboard them.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Scanned</p>
          <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{report?.scanned ?? (isLoading ? "…" : 0)}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Drift</p>
          <p className="mt-2 text-2xl font-semibold text-amber-600 dark:text-amber-300">{drift.length}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Privileged</p>
          <p className="mt-2 text-2xl font-semibold text-red-600 dark:text-red-300">{privileged.length}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-slate-500">Scanning directory…</p>
        ) : drift.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            No drift detected — every ACTIVE account is accounted for in users.yaml.
          </p>
        ) : (
          <div className="space-y-2">
            {drift.map((entry) => (
              <DriftRow key={entry.username} entry={entry} canManage={canManage} onOffboard={setOffboardUsername} />
            ))}
          </div>
        )}
      </div>

      {offboardUsername ? (
        <OffboardWizard
          open
          username={offboardUsername}
          onClose={() => {
            setOffboardUsername(null);
            void refetch();
          }}
        />
      ) : null}
    </div>
  );
}
