// Map a raw Kubernetes cluster event to a notification RawSignal.
//
// The namespace is the authoritative app-grouping unit (matches
// lib/pod-app-grouping.ts and "Stop app" semantics), so it is used as the app
// label. The reason is the cause bucket; the involved object drives the
// fingerprint (its volatile suffix is stripped downstream).

import type { ClusterEventItem } from "@/lib/ops-data";
import type { NotificationLevel, RawSignal } from "./types";

function levelFor(event: Pick<ClusterEventItem, "level" | "type">): NotificationLevel {
  if (event.level === "error") return "error";
  return "warning";
}

/** True for events worth surfacing in the bell (Warning/abnormal only). */
export function isNotifiableEvent(event: Pick<ClusterEventItem, "type">): boolean {
  return event.type === "Warning";
}

export function mapEventToSignal(event: ClusterEventItem): RawSignal {
  const app = event.namespace || "cluster";
  const object = `${event.involvedObject.kind}/${event.involvedObject.name}`;
  const timestamp = new Date(event.lastSeen ?? event.firstSeen ?? Date.now()).getTime();

  return {
    key: event.id,
    app,
    cause: event.reason || "Event",
    reason: event.reason,
    object,
    namespace: event.namespace,
    title: `${event.reason} · ${event.involvedObject.kind}/${event.involvedObject.name}`,
    body: `${event.namespace}: ${event.message}`,
    level: levelFor(event),
    timestamp,
  };
}

/** Convenience: filter to notifiable events and map them to signals. */
export function eventsToSignals(events: readonly ClusterEventItem[]): RawSignal[] {
  return events.filter(isNotifiableEvent).map(mapEventToSignal);
}
