"use client";

import { useEffect, useState } from "react";
import { KeyRound, RefreshCw, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui";
import { useApiMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  classifyTokenTtl,
  SEVERITY_META,
  TOKEN_TTL_CRITICAL_SECONDS,
  TOKEN_TTL_WARN_SECONDS,
  type TokenStatus,
} from "@/lib/secrets/lifecycle-types";

const TICK_INTERVAL_MS = 30_000;

/** Re-render on an interval so the live countdown stays fresh between refetches. */
function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Remaining seconds from the absolute expire time (falls back to the snapshot TTL). */
function remainingSeconds(token: TokenStatus, now: number): number | null {
  if (token.expireTime) {
    const expiresAt = new Date(token.expireTime).getTime();
    if (Number.isFinite(expiresAt)) return Math.round((expiresAt - now) / 1000);
  }
  return token.ttlSeconds;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

export interface TokenExpiryCardProps {
  token: TokenStatus;
  canRemediate: boolean;
}

export function TokenExpiryCard({ token, canRemediate }: TokenExpiryCardProps) {
  const now = useNowTick(TICK_INTERVAL_MS);
  const remaining = remainingSeconds(token, now);
  const severity = classifyTokenTtl({ available: token.available, ttlSeconds: remaining });

  const renewMutation = useApiMutation<{ ok: boolean; ttlSeconds: number | null }, void>({
    path: "/api/secrets/lifecycle/renew-token",
    successMessage: "OpenBao token renewed",
    invalidateQueryKeys: [queryKeys.secrets.lifecycle()],
  });

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">OpenBao Token TTL</h3>
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", SEVERITY_META[severity].badgeClass)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_META[severity].dotClass)} aria-hidden="true" />
          {SEVERITY_META[severity].label}
        </span>
      </div>

      {!token.available ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Token status unavailable{token.error ? ` — ${token.error}` : ""}. Ensure the console token has
          <span className="font-mono"> auth/token/lookup-self</span> capability.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-baseline gap-2">
            <Timer className="h-5 w-5 text-slate-400" aria-hidden="true" />
            <span className={cn("text-3xl font-bold", severity === "critical" ? "text-red-400" : severity === "warn" ? "text-yellow-400" : "text-green-400")}>
              {remaining === null ? "—" : formatDuration(remaining)}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">remaining</span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
            <dt className="text-slate-500">Expires</dt>
            <dd className="text-right"><RelativeTime date={token.expireTime} /></dd>
            <dt className="text-slate-500">Renewable</dt>
            <dd className="text-right">{token.renewable ? "Yes" : "No"}</dd>
            <dt className="text-slate-500">Policies</dt>
            <dd className="text-right font-mono">{token.policies.length > 0 ? token.policies.join(", ") : "—"}</dd>
          </dl>

          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Warn under {Math.round(TOKEN_TTL_WARN_SECONDS / 86_400)}d · critical under {Math.round(TOKEN_TTL_CRITICAL_SECONDS / 86_400)}d. A dead token flips every ExternalSecret to not-Ready.
          </p>

          {canRemediate ? (
            <button
              type="button"
              onClick={() => renewMutation.mutate()}
              disabled={renewMutation.isPending || !token.renewable}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"
              title={token.renewable ? "Extend this token's lease" : "This token is not renewable — re-mint instead"}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", renewMutation.isPending && "animate-spin")} aria-hidden="true" />
              {renewMutation.isPending ? "Renewing…" : "Renew token"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
