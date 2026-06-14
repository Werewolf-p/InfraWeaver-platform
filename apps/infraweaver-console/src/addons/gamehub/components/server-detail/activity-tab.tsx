"use client";

import { useQuery } from "@tanstack/react-query";
import type { AuditEntry, GameEvent } from "./types";
import { fetchJson } from "./utils";

export function ActivityTab({ name }: { name: string }) {
  const { data: events } = useQuery({ queryKey: ["game-hub", "events", name], queryFn: () => fetchJson<{ events: GameEvent[] }>(`/api/game-hub/servers/${name}/events`), refetchInterval: 30000 });
  const { data: audit } = useQuery({ queryKey: ["game-hub", "audit", name], queryFn: () => fetchJson<{ entries: AuditEntry[] }>(`/api/game-hub/servers/${name}/audit`), refetchInterval: 30000 });
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden"><div className="px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e] text-xs uppercase tracking-wide text-gray-500 dark:text-[#888]">Cluster Events</div><div className="divide-y divide-[#1e1e1e]">{(events?.events ?? []).map((event, index) => <div key={`${event.reason}-${index}`} className="px-4 py-3"><p className="text-sm text-gray-900 dark:text-[#f2f2f2]">{event.reason}</p><p className="text-xs text-gray-400 dark:text-[#666] mt-1">{event.message}</p></div>)}</div></div>
      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden"><div className="px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e] text-xs uppercase tracking-wide text-gray-500 dark:text-[#888]">Audit Log / Recent Sessions</div><div className="divide-y divide-[#1e1e1e]">{(audit?.entries ?? []).map((entry, index) => <div key={`${entry.timestamp}-${index}`} className="px-4 py-3"><p className="text-sm text-gray-900 dark:text-[#f2f2f2]">{entry.action}</p><p className="text-xs text-gray-400 dark:text-[#666] mt-1">{entry.user} · {new Date(entry.timestamp).toLocaleString()}</p><p className="text-xs text-gray-400 dark:text-[#555] mt-1">{entry.details}</p></div>)}</div></div>
    </div>
  );
}
