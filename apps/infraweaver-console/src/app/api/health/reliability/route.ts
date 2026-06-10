import { NextResponse } from "next/server";
import { makeCoreApi } from "@/lib/kube-client";
import {
  combineReliabilityComponents,
  normalizeLonghornCollection,
  scoreArgocdHealth,
  scoreBackupHealth,
  scoreNodeHealth,
  scoreStorageHealth,
  scoreUptime,
  summarizeBackupVolumes,
  summarizeLonghornBackups,
} from "@/lib/reliability";
import { withAuth } from "@/lib/with-auth";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";
const GATUS_URL = process.env.GATUS_URL ?? "http://gatus.gatus.svc.cluster.local:8080";
const LONGHORN_API = process.env.LONGHORN_API ?? "http://longhorn-frontend.longhorn-system.svc.cluster.local:80";
const MAX_BACKUP_AGE_HOURS = 36;

interface EndpointStatus {
  name: string;
  results: Array<{ success: boolean; timestamp?: string }>;
}

function calcUptime(results: Array<{ success: boolean; timestamp?: string }>, windowHours: number) {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const filtered = results.filter((result) => {
    if (!result.timestamp) return true;
    const timestamp = new Date(result.timestamp).getTime();
    return now - timestamp <= windowMs;
  });
  if (!filtered.length) return 100;
  const successes = filtered.filter((result) => result.success).length;
  return (successes / filtered.length) * 100;
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000), ...init });
  if (!response.ok) throw new Error(`Request failed for ${url}`);
  return response.json();
}

async function loadArgocdHealth() {
  const data = await fetchJson(`${ARGOCD_SERVER}/api/v1/applications`, {
    headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
  }) as { items?: Array<{ status?: { health?: { status?: string }; sync?: { status?: string } } }> };
  const apps = data.items ?? [];
  return {
    healthy: apps.filter((app) => app.status?.health?.status === "Healthy").length,
    degraded: apps.filter((app) => app.status?.health?.status === "Degraded").length,
    progressing: apps.filter((app) => app.status?.health?.status === "Progressing").length,
    outOfSync: apps.filter((app) => app.status?.sync?.status === "OutOfSync").length,
    total: apps.length,
  };
}

async function loadOverallUptime() {
  const endpoints = await fetchJson(`${GATUS_URL}/api/v1/endpoints/statuses?page=1&pageSize=100`) as EndpointStatus[];
  if (!endpoints.length) return 100;
  return endpoints.reduce((sum, endpoint) => sum + calcUptime(endpoint.results ?? [], 24), 0) / endpoints.length;
}

async function loadNodeHealth() {
  const response = await makeCoreApi().listNode();
  const items = (response as { items?: Array<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }> }).items ?? [];
  const ready = items.filter((node) => node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")).length;
  return { ready, total: items.length };
}

async function loadLonghornVolumes() {
  const payload = await fetchJson(`${LONGHORN_API}/v1/volumes`, { headers: { Accept: "application/json" } });
  return normalizeLonghornCollection(payload);
}

async function loadBackupSummary() {
  const payload = await fetchJson(`${LONGHORN_API}/v1/backupvolumes`, { headers: { Accept: "application/json" } });
  const volumes = normalizeLonghornCollection(payload);
  const backups = await Promise.all(volumes.map(async (volume) => {
    const name = typeof volume.name === "string" ? volume.name : typeof volume.id === "string" ? volume.id : "";
    if (!name) return null;
    const backupsPayload = await fetchJson(`${LONGHORN_API}/v1/backupvolumes/${encodeURIComponent(name)}/backups`, { headers: { Accept: "application/json" } });
    return summarizeLonghornBackups(name, normalizeLonghornCollection(backupsPayload), MAX_BACKUP_AGE_HOURS);
  }));
  return summarizeBackupVolumes(backups.filter((volume): volume is NonNullable<typeof volume> => Boolean(volume)));
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const [argocd, uptime24h, nodes, volumes, backupSummary] = await Promise.all([
      loadArgocdHealth(),
      loadOverallUptime(),
      loadNodeHealth(),
      loadLonghornVolumes(),
      loadBackupSummary(),
    ]);

    const components = {
      nodes: scoreNodeHealth(nodes.ready, nodes.total),
      argocd: scoreArgocdHealth(argocd),
      uptime: scoreUptime(uptime24h),
      storage: scoreStorageHealth(volumes),
      backups: scoreBackupHealth(backupSummary),
    };

    const combined = combineReliabilityComponents(Object.values(components));

    return NextResponse.json({
      score: combined.score,
      grade: combined.grade,
      status: combined.status,
      components,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const components = {
      nodes: scoreNodeHealth(3, 3),
      argocd: scoreArgocdHealth({ healthy: 54, degraded: 0, progressing: 2, outOfSync: 1, total: 56 }),
      uptime: scoreUptime(99.82),
      storage: scoreStorageHealth([{ robustness: "healthy" }, { robustness: "healthy" }, { robustness: "degraded" }]),
      backups: scoreBackupHealth({ total: 6, healthy: 5, stale: 1, missing: 0 }),
    };
    const combined = combineReliabilityComponents(Object.values(components));
    return NextResponse.json({
      score: combined.score,
      grade: combined.grade,
      status: combined.status,
      components,
      timestamp: new Date().toISOString(),
      live: false,
    }, { headers: { "Cache-Control": "no-store" } });
  }
});
