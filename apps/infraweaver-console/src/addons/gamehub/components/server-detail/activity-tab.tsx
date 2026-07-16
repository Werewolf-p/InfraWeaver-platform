"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AuditEntry, GameEvent } from "./types";
import { fetchJson } from "./utils";
import { explainEvent, severityFor, type EventSeverity } from "../../lib/event-explain";

interface AggregatedEvent extends GameEvent {
  key: string;
  friendly: string;
  severity: EventSeverity;
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "just now";
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return "just now";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

/**
 * Collapses repeated events (the scheduler retries the same failure every few
 * seconds) into a single row with a combined count and the most recent time.
 */
function aggregateEvents(events: GameEvent[]): AggregatedEvent[] {
  const byKey = new Map<string, AggregatedEvent>();
  for (const event of events) {
    const key = `${event.reason}|${event.message}|${event.involvedName}`;
    const existing = byKey.get(key);
    const count = Math.max(1, event.count ?? 1);
    if (existing) {
      existing.count += count;
      if ((event.timestamp ?? "") > (existing.timestamp ?? "")) existing.timestamp = event.timestamp;
    } else {
      byKey.set(key, {
        ...event,
        key,
        count,
        friendly: explainEvent(event.reason, event.message),
        severity: severityFor(event),
      });
    }
  }
  return [...byKey.values()].sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""));
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e] text-xs uppercase tracking-wide text-gray-500 dark:text-[#888]">{title}</div>
      <div className="divide-y divide-gray-100 dark:divide-[#1e1e1e]">{children}</div>
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <div className="px-4 py-6 text-sm text-gray-400 dark:text-[#9a9a9a]">{label}</div>;
}

export function ActivityTab({ name }: { name: string }) {
  const eventsQuery = useQuery({ queryKey: ["game-hub", "events", name], queryFn: () => fetchJson<{ events: GameEvent[] }>(`/api/game-hub/servers/${name}/events`), refetchInterval: 30000 });
  const auditQuery = useQuery({ queryKey: ["game-hub", "audit", name], queryFn: () => fetchJson<{ entries: AuditEntry[] }>(`/api/game-hub/servers/${name}/audit`), refetchInterval: 30000 });

  const events = useMemo(() => aggregateEvents(eventsQuery.data?.events ?? []), [eventsQuery.data]);
  const audit = auditQuery.data?.entries ?? [];

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Panel title="Cluster Events">
        {eventsQuery.isLoading ? (
          <EmptyRow label="Loading events…" />
        ) : eventsQuery.isError ? (
          <EmptyRow label="Could not load cluster events." />
        ) : events.length === 0 ? (
          <EmptyRow label="No recent events. The server is stable." />
        ) : (
          events.map((event) => (
            <div key={event.key} className="px-4 py-3 flex items-start gap-3">
              <span
                aria-hidden
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${event.severity === "warning" ? "bg-amber-500" : "bg-gray-300 dark:bg-[#3a3a3a]"}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{event.reason || "Event"}</p>
                  {event.count > 1 && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-[#1e1e1e] text-gray-500 dark:text-[#888]">×{event.count}</span>
                  )}
                  <span className="text-xs text-gray-400 dark:text-[#9a9a9a] ml-auto">{formatRelativeTime(event.timestamp)}</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-[#888] mt-1">{event.friendly}</p>
                {event.involvedName && (
                  <p className="text-[11px] text-gray-400 dark:text-[#8a8a8a] mt-1">{event.involvedKind || "Object"}: {event.involvedName}</p>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Audit Log / Recent Sessions">
        {auditQuery.isLoading ? (
          <EmptyRow label="Loading audit log…" />
        ) : audit.length === 0 ? (
          <EmptyRow label="No recorded activity yet." />
        ) : (
          audit.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="text-sm text-gray-900 dark:text-[#f2f2f2]">{entry.action}</p>
                <span className="text-xs text-gray-400 dark:text-[#9a9a9a] ml-auto">{formatRelativeTime(entry.timestamp)}</span>
              </div>
              <p className="text-xs text-gray-400 dark:text-[#9a9a9a] mt-1">{entry.user} · {new Date(entry.timestamp).toLocaleString()}</p>
              {entry.details && <p className="text-xs text-gray-400 dark:text-[#8a8a8a] mt-1">{entry.details}</p>}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
