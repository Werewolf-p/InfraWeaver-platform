"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCheck, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { cn, timeAgo } from "@/lib/utils";
import { loadAckedEventIds, saveAckedEventIds, subscribeAckedEventIds } from "@/lib/event-ack";

interface ClusterEvent {
  id: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  level: "info" | "warning" | "error";
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  sourceComponent: string | null;
  involvedObject: { kind: string; name: string };
}

interface EventsResponse {
  events: ClusterEvent[];
  live: boolean;
  summary: { total: number; warnings: number; errors: number; namespaces: number };
}

function formatTimestamp(value: string | null) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function EventsPage() {
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "Warning" | "Normal">("all");
  const [hideAcked, setHideAcked] = useState(false);
  const [ackedIds, setAckedIds] = useState<string[]>(() => loadAckedEventIds());

  useEffect(() => subscribeAckedEventIds(() => setAckedIds(loadAckedEventIds())), []);

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery<EventsResponse>({
    queryKey: ["cluster-events"],
    queryFn: async () => {
      const response = await fetch("/api/cluster/events", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch events");
      return response.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const events = useMemo(() => data?.events ?? [], [data?.events]);
  const namespaces = useMemo(
    () => Array.from(new Set(events.map((event) => event.namespace))).sort(),
    [events]
  );

  const filteredEvents = useMemo(() => events.filter((event) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query
      || event.reason.toLowerCase().includes(query)
      || event.message.toLowerCase().includes(query)
      || event.namespace.toLowerCase().includes(query)
      || event.involvedObject.name.toLowerCase().includes(query);
    const matchesNamespace = namespaceFilter === "all" || event.namespace === namespaceFilter;
    const matchesType = typeFilter === "all" || event.type === typeFilter;
    const isAcked = ackedIds.includes(event.id);
    return matchesSearch && matchesNamespace && matchesType && (!hideAcked || !isAcked);
  }), [ackedIds, events, hideAcked, namespaceFilter, search, typeFilter]);

  const warningEvents = filteredEvents.filter((event) => event.type === "Warning");
  const unackedWarnings = warningEvents.filter((event) => !ackedIds.includes(event.id));

  const acknowledgeEvents = useCallback((ids: string[]) => {
    saveAckedEventIds([...ackedIds, ...ids]);
  }, [ackedIds]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={AlertTriangle}
        title="Events"
        subtitle="Cluster-wide Kubernetes event feed with acknowledgement workflow"
        badge={data?.live === false ? "offline" : "live"}
        actions={
          <>
            <RefreshCountdown intervalSeconds={15} resetKey={dataUpdatedAt} />
            <button
              onClick={() => void refetch()}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
              Refresh
            </button>
          </>
        }
      />

      {data?.live === false ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Kubernetes unavailable — cluster events cannot be loaded. Check cluster connectivity.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Open warnings</p>
          <p className="mt-2 text-3xl font-semibold text-yellow-300">{unackedWarnings.length}</p>
          <p className="mt-1 text-xs text-slate-500">Warning events not yet acknowledged</p>
        </div>
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-red-200/80">Errors</p>
          <p className="mt-2 text-3xl font-semibold text-red-300">{data?.summary.errors ?? 0}</p>
          <p className="mt-1 text-xs text-red-100/70">BackOff, failure, or unhealthy signals</p>
        </div>
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Warnings</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900 dark:text-white">{data?.summary.warnings ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">Total warning events in the current feed</p>
        </div>
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Namespaces</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900 dark:text-white">{data?.summary.namespaces ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">Distinct namespaces represented</p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by namespace, reason, message, or object…"
              className="w-full rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
            />
          </div>
          <select
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>{namespace}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as "all" | "Warning" | "Normal")}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">All types</option>
            <option value="Warning">Warnings</option>
            <option value="Normal">Normal</option>
          </select>
          <button
            onClick={() => setHideAcked((value) => !value)}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-sm transition",
              hideAcked ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300" : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-700 dark:text-slate-300"
            )}
          >
            {hideAcked ? "Showing open only" : "Show acknowledged"}
          </button>
          <button
            onClick={() => acknowledgeEvents(unackedWarnings.map((event) => event.id))}
            disabled={unackedWarnings.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCheck className="h-4 w-4" />
            Ack visible warnings
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-28 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>
      ) : filteredEvents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 py-16 text-center text-sm text-slate-500">
          No events matched the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEvents.map((event) => {
            const isAcked = ackedIds.includes(event.id);
            return (
              <div
                key={event.id}
                className={cn(
                  "rounded-2xl border p-4 transition",
                  event.type === "Warning"
                    ? event.level === "error"
                      ? "border-red-500/30 bg-red-500/10"
                      : "border-yellow-500/30 bg-yellow-500/10"
                    : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70"
                )}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium",
                        event.type === "Warning"
                          ? event.level === "error"
                            ? "bg-red-500/20 text-red-200"
                            : "bg-yellow-500/20 text-yellow-100"
                          : "bg-blue-500/15 text-blue-200"
                      )}>
                        {event.reason}
                      </span>
                      <span className="rounded-full border border-gray-200 dark:border-white/10 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {event.namespace}
                      </span>
                      <span className="rounded-full border border-gray-200 dark:border-white/10 px-2.5 py-1 text-xs text-slate-500 dark:text-slate-400">
                        {event.involvedObject.kind}/{event.involvedObject.name}
                      </span>
                      {isAcked ? <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">Acknowledged</span> : null}
                    </div>
                    <p className="text-sm text-gray-900 dark:text-white">{event.message}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>Seen {timeAgo(event.lastSeen ?? event.firstSeen ?? new Date().toISOString())}</span>
                      <span>Last update {formatTimestamp(event.lastSeen)}</span>
                      <span>Count ×{event.count}</span>
                      {event.sourceComponent ? <span>Source {event.sourceComponent}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {event.type === "Warning" ? (
                      <button
                        onClick={() => acknowledgeEvents([event.id])}
                        disabled={isAcked}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {isAcked ? "Acknowledged" : "Acknowledge"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
