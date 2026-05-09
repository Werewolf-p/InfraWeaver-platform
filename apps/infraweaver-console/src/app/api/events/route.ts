import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";

const mockEvents = [
  { name: "argocd-sync-1", namespace: "argocd", reason: "Sync", message: "Successfully synced application", type: "Normal", count: 1, lastTimestamp: new Date().toISOString(), involvedObject: { kind: "Application", name: "apps-grafana" } },
  { name: "pod-restart-1", namespace: "netbird", reason: "BackOff", message: "Back-off restarting failed container", type: "Warning", count: 3, lastTimestamp: new Date(Date.now() - 300000).toISOString(), involvedObject: { kind: "Pod", name: "netbird-0" } },
  { name: "node-ready-1", namespace: "default", reason: "NodeReady", message: "Node became ready", type: "Normal", count: 1, lastTimestamp: new Date(Date.now() - 600000).toISOString(), involvedObject: { kind: "Node", name: "talos-prod-cp1" } },
];

export async function GET() {
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const eventsRes = await coreApi.listEventForAllNamespaces();
    const items = ((eventsRes as { items?: unknown[] }).items ?? [])
      .map((e: unknown) => {
        const ev = e as {
          metadata?: { name?: string; namespace?: string };
          reason?: string;
          message?: string;
          type?: string;
          count?: number;
          firstTimestamp?: Date;
          lastTimestamp?: Date;
          involvedObject?: { kind?: string; name?: string };
        };
        return {
          name: ev.metadata?.name,
          namespace: ev.metadata?.namespace,
          reason: ev.reason,
          message: ev.message,
          type: ev.type,
          count: ev.count,
          firstTimestamp: ev.firstTimestamp?.toISOString?.() ?? null,
          lastTimestamp: ev.lastTimestamp?.toISOString?.() ?? null,
          involvedObject: { kind: ev.involvedObject?.kind, name: ev.involvedObject?.name },
        };
      })
      .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
      .slice(0, 50);
    return NextResponse.json({ events: items, live: true });
  } catch {
    return NextResponse.json({ events: mockEvents, live: false });
  }
}
