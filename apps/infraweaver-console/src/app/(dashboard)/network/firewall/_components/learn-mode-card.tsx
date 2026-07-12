"use client";

import { useCallback, useEffect, useState } from "react";
import { GraduationCap, Loader2, ShieldCheck } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";

interface LearnedQuery {
  fqdn: string;
  count: number;
}

interface LearnStatus {
  active: boolean;
  since?: string | null;
  learned: LearnedQuery[];
}

interface LearnModeCardProps {
  namespace: string;
  podNames: readonly string[];
  /** Called after enable/disable/commit so the parent can refresh denies/rules. */
  onChanged?: () => void;
}

const POLL_MS = 15000;

/**
 * Learn & temp allow: opens everything for this app's pods via a temporary
 * <app>-learn-mode CiliumNetworkPolicy while listing every FQDN the app
 * resolves. "Allow learned" turns that list into egress allowlist rules and
 * re-seals. Learning covers FQDN egress only — raw-IP flows reappear as
 * blocked flows once learn mode ends.
 */
export function LearnModeCard({ namespace, podNames, onChanged }: LearnModeCardProps) {
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  const podsParam = podNames.join(",");

  const query = useApiQuery<LearnStatus>({
    queryKey: ["network", "learn-mode", namespace, podsParam],
    path: `/api/network/learn-mode?namespace=${encodeURIComponent(namespace)}&pods=${encodeURIComponent(podsParam)}`,
    request: { cache: "no-store" },
    refetchInterval: POLL_MS,
    enabled: podsParam.length > 0,
  });
  const status = query.data ?? null;
  const { dataUpdatedAt, refetch } = query;

  // The single error slot used to be cleared by every successful poll — keep
  // that: a stale action error disappears once fresh learn state arrives.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- no-op unless an action error is currently showing
    setActError(null);
  }, [dataUpdatedAt]);

  const act = useCallback(
    async (action: "enable" | "disable" | "commit") => {
      setBusy(true);
      setActError(null);
      try {
        const res = await fetch("/api/network/learn-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace, pods: podNames, action }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        await refetch();
        onChanged?.();
      } catch (e) {
        setActError(e instanceof Error ? e.message : "Learn mode action failed");
      } finally {
        setBusy(false);
      }
    },
    [namespace, podNames, refetch, onChanged],
  );

  const error = actError ?? (query.error ? query.error.message : null);

  const active = status?.active ?? false;
  const learned = status?.learned ?? [];

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3.5",
        active
          ? "border-amber-300/60 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/[0.06]"
          : "border-slate-200 dark:border-[#262626]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <GraduationCap className={cn("h-4 w-4", active ? "text-amber-500" : "text-slate-400")} aria-hidden />
          <div>
            <p className="text-sm font-medium text-slate-800 dark:text-[#ddd]">Learn &amp; temp allow</p>
            <p className="text-xs text-slate-500 dark:text-[#999]">
              {active
                ? "All traffic is temporarily allowed for this app — every domain it contacts is being recorded."
                : "Temporarily allow everything while recording each domain the app contacts, then allow them all in one click."}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={active}
          aria-label="Learn and temporarily allow all traffic"
          disabled={busy}
          onClick={() => act(active ? "disable" : "enable")}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
            active ? "bg-amber-500" : "bg-slate-300 dark:bg-[#333]",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
              active ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {active && (
        <div className="mt-3 space-y-3">
          {learned.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-[#999]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Nothing learned yet — exercise the app (open pages, run updates) and domains appear here.
            </p>
          ) : (
            <ul className="max-h-56 divide-y divide-amber-200/50 overflow-y-auto rounded-lg border border-amber-200/60 dark:divide-amber-500/10 dark:border-amber-500/20">
              {learned.map((q) => (
                <li key={q.fqdn} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="truncate font-mono text-slate-700 dark:text-[#ccc]">{q.fqdn}</span>
                  <span className="ml-3 shrink-0 tabular-nums text-slate-400">{Math.round(q.count)}×</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-slate-500 dark:text-[#888]">
              Learns domain (FQDN) egress only — raw-IP flows show up as blocked again afterwards.
            </p>
            <button
              type="button"
              disabled={busy || learned.length === 0}
              onClick={() => act("commit")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
              Allow learned ({learned.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
