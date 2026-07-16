"use client";

import Link from "next/link";
import { ArrowUpRight, KeyRound, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApiQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SEVERITY_META, type SecretLifecycleReport } from "@/lib/secrets/lifecycle-types";

/**
 * Compact, shared Secret-health card. This is the SINGLE secret-health widget
 * (coordination contract, idea 10): the `/secret-health` page AND Subject 2's
 * observability board both render THIS component, backed by the one
 * `/api/secrets/lifecycle` collector — nobody re-derives token/ES/seal state.
 */
export interface SecretHealthSummaryProps {
  /** Show the "Open Secret Health" link (default true). Set false when embedded on that page. */
  showLink?: boolean;
  className?: string;
}

interface SummaryStat {
  label: string;
  value: number | string;
  emphasize?: boolean;
}

function buildStats(report: SecretLifecycleReport): SummaryStat[] {
  const ttlDays = report.token.available && report.token.ttlSeconds !== null
    ? Math.floor(report.token.ttlSeconds / 86_400)
    : null;
  return [
    { label: "Token TTL", value: ttlDays === null ? "—" : `${ttlDays}d`, emphasize: ttlDays !== null && ttlDays <= 30 },
    { label: "ES not-ready", value: report.externalSecrets.notReady, emphasize: report.externalSecrets.notReady > 0 },
    { label: "Retain traps", value: report.externalSecrets.retainTraps, emphasize: report.externalSecrets.retainTraps > 0 },
    { label: "Missing keys", value: report.catalogCoverage.totalMissing, emphasize: report.catalogCoverage.totalMissing > 0 },
  ];
}

function topOffender(report: SecretLifecycleReport): string | null {
  if (report.openbao.available && report.openbao.sealed) return "OpenBao is sealed";
  if (report.token.available && report.token.ttlSeconds !== null && report.token.ttlSeconds <= 0) return "OpenBao token has expired";
  const trap = report.externalSecrets.items.find((es) => es.isRetainTrap);
  if (trap) return `Retain trap: ${trap.namespace}/${trap.name}`;
  const notReady = report.externalSecrets.items.find((es) => !es.ready);
  if (notReady) return `Not ready: ${notReady.namespace}/${notReady.name}`;
  if (report.publicMirror.available && report.publicMirror.conclusion === "failure") return "Public mirror sync failing";
  return null;
}

export function SecretHealthSummary({ showLink = true, className }: SecretHealthSummaryProps) {
  const { data, isLoading, isError } = useApiQuery<SecretLifecycleReport>({
    queryKey: queryKeys.secrets.lifecycle(),
    path: "/api/secrets/lifecycle",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return (
    <div className={cn("rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Secret &amp; GitOps Health</h3>
        </div>
        {data ? (
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", SEVERITY_META[data.severity].badgeClass)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_META[data.severity].dotClass)} aria-hidden="true" />
            {SEVERITY_META[data.severity].label}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="mt-4 h-16 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />
      ) : isError || !data ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Secret lifecycle data is unavailable.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {buildStats(data).map((stat) => (
              <div key={stat.label} className="rounded-xl border border-gray-200 dark:border-white/5 bg-white/50 dark:bg-slate-950/40 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{stat.label}</p>
                <p className={cn("mt-0.5 text-lg font-bold", stat.emphasize ? "text-orange-400" : "text-gray-900 dark:text-white")}>{stat.value}</p>
              </div>
            ))}
          </div>

          {topOffender(data) ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <ShieldAlert className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
              {topOffender(data)}
            </p>
          ) : null}

          {showLink ? (
            <Link
              href="/secret-health"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400"
            >
              Open Secret Health
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
