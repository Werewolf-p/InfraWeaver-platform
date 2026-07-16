"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCheck, ShieldCheck } from "lucide-react";
import { CopyButton, DashboardStatCard, EmptyState, FilterSelect, KubeOfflineBanner, PageScaffold, RefreshButton, SearchInput } from "@/components/ui";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { useApiQuery } from "@/hooks/use-api-query";
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

const LEVEL_RANK: Record<ClusterEvent["level"], number> = { error: 0, warning: 1, info: 2 };

function eventTime(event: ClusterEvent): number {
  const value = event.lastSeen ?? event.firstSeen;
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectRefCommand(event: ClusterEvent): string {
  return `kubectl -n ${event.namespace} describe ${event.involvedObject.kind.toLowerCase()}/${event.involvedObject.name}`;
}

export default function EventsPage() {
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "Warning" | "Normal">("all");
  const [hideAcked, setHideAcked] = useState(false);
  const [ackedIds, setAckedIds] = useState<Set<string>>(() => new Set(loadAckedEventIds()));

  useEffect(() => subscribeAckedEventIds(() => setAckedIds(new Set(loadAckedEventIds()))), []);

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useApiQuery<EventsResponse>({
    queryKey: ["cluster-events"],
    path: "/api/cluster/events",
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const events = useMemo(() => data?.events ?? [], [data?.events]);
  const namespaces = useMemo(
    () => Array.from(new Set(events.map((event) => event.namespace))).sort(),
    [events]
  );

  const filteredEvents = useMemo(() => {
    const matched = events.filter((event) => {
      const query = search.trim().toLowerCase();
      const matchesSearch = !query
        || event.reason.toLowerCase().includes(query)
        || event.message.toLowerCase().includes(query)
        || event.namespace.toLowerCase().includes(query)
        || event.involvedObject.name.toLowerCase().includes(query);
      const matchesNamespace = namespaceFilter === "all" || event.namespace === namespaceFilter;
      const matchesType = typeFilter === "all" || event.type === typeFilter;
      const isAcked = ackedIds.has(event.id);
      return matchesSearch && matchesNamespace && matchesType && (!hideAcked || !isAcked);
    });
    // Read like a triage queue: errors first, then warnings, then normal — recency breaks ties.
    return matched.sort((a, b) => {
      if (LEVEL_RANK[a.level] !== LEVEL_RANK[b.level]) return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
      return eventTime(b) - eventTime(a);
    });
  }, [ackedIds, events, hideAcked, namespaceFilter, search, typeFilter]);

  const warningEvents = filteredEvents.filter((event) => event.type === "Warning");
  const unackedWarnings = warningEvents.filter((event) => !ackedIds.has(event.id));

  const acknowledgeEvents = useCallback((ids: string[]) => {
    saveAckedEventIds([...new Set([...ackedIds, ...ids])]);
  }, [ackedIds]);

  return (
    <PageScaffold
      icon={AlertTriangle}
      title="Events"
      subtitle="Cluster-wide Kubernetes event feed with acknowledgement workflow"
      badge={data?.live === false ? "offline" : "live"}
      actions={
        <>
          <RefreshCountdown intervalSeconds={15} resetKey={dataUpdatedAt} />
          <RefreshButton onClick={() => void refetch()} refreshing={isFetching} />
        </>
      }
      loading={isLoading}
      bodyClassName="space-y-6"
    >
      <KubeOfflineBanner show={data?.live === false} resource="cluster events" />

      <div className="grid gap-4 md:grid-cols-4">
        <DashboardStatCard label="Open warnings" value={unackedWarnings.length} tone="warning" description="Warning events not yet acknowledged" />
        <DashboardStatCard label="Errors" value={data?.summary.errors ?? 0} tone="danger" description="BackOff, failure, or unhealthy signals" />
        <DashboardStatCard label="Warnings" value={data?.summary.warnings ?? 0} description="Total warning events in the current feed" />
        <DashboardStatCard label="Namespaces" value={data?.summary.namespaces ?? 0} description="Distinct namespaces represented" />
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by namespace, reason, message, or object…"
            className="flex-1"
          />
          <FilterSelect
            label="Filter by namespace"
            value={namespaceFilter}
            onChange={setNamespaceFilter}
            options={[{ value: "all", label: "All namespaces" }, ...namespaces]}
          />
          <FilterSelect
            label="Filter by type"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as "all" | "Warning" | "Normal")}
            options={[
              { value: "all", label: "All types" },
              { value: "Warning", label: "Warnings" },
              { value: "Normal", label: "Normal" },
            ]}
          />
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

      {filteredEvents.length === 0 ? (
        <EmptyState icon={AlertTriangle} title="No events matched the current filters." />
      ) : (
        <div className="space-y-3">
          {filteredEvents.map((event) => {
            const isAcked = ackedIds.has(event.id);
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
                      {event.count > 1 ? (
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
                            event.count >= 50
                              ? "bg-red-500/20 text-red-200"
                              : event.count >= 10
                                ? "bg-amber-500/20 text-amber-100"
                                : "bg-slate-500/15 text-slate-600 dark:text-slate-300",
                          )}
                          title={`Fired ${event.count} times`}
                        >
                          ×{event.count}
                        </span>
                      ) : null}
                      {isAcked ? <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">Acknowledged</span> : null}
                    </div>
                    <p className="text-sm text-gray-900 dark:text-white">{event.message}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>Seen {timeAgo(event.lastSeen ?? event.firstSeen ?? new Date().toISOString())}</span>
                      <span>Last update {formatTimestamp(event.lastSeen)}</span>
                      {event.sourceComponent ? <span>Source {event.sourceComponent}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <CopyButton text={objectRefCommand(event)} label="describe" className="h-9" />
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
    </PageScaffold>
  );
}
