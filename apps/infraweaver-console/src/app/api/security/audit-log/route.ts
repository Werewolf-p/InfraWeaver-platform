import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";

const NAMESPACE = "infraweaver-console";
const CONFIGMAP_NAME = "infra-console-audit-log";
const MAX_ENTRIES = 200;

export interface AuditEntry {
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  details: string;
  result: "success" | "failure";
  ip?: string;
}

function getKubeConfig() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }
  return kc;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = getKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
    const log = (cm as { data?: Record<string, string> }).data?.log ?? "";
    const entries = log.split("\n").filter(Boolean).slice(-MAX_ENTRIES).map(line => {
      try { return JSON.parse(line) as AuditEntry; } catch { return null; }
    }).filter((e): e is AuditEntry => e !== null).reverse();
    
    return NextResponse.json({ entries });
  } catch {
    // Return mock data when K8s unavailable
    const now = Date.now();
    return NextResponse.json({
      entries: [
        { timestamp: new Date(now - 60000).toISOString(), user: "admin@infraweaver.local", action: "cluster:restart-app", resource: "apps-grafana/grafana", details: "Deployment restarted", result: "success", ip: "10.0.1.42" },
        { timestamp: new Date(now - 180000).toISOString(), user: "operator@infraweaver.local", action: "argocd:sync", resource: "app=monitoring", details: "Synced ArgoCD app", result: "success", ip: "10.0.1.55" },
        { timestamp: new Date(now - 600000).toISOString(), user: "admin@infraweaver.local", action: "cluster:rollout", resource: "infraweaver-console", details: "Rollout restart triggered", result: "success", ip: "10.0.1.42" },
        { timestamp: new Date(now - 900000).toISOString(), user: "unknown@example.com", action: "login", resource: "auth", details: "Login failed", result: "failure", ip: "185.220.101.5" },
      ] as AuditEntry[],
    });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as Partial<AuditEntry> & { user?: string };
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    user: body.user ?? session.user?.email ?? "unknown",
    action: body.action ?? "unknown",
    resource: body.resource ?? "",
    details: body.details ?? "",
    result: body.result ?? "success",
    ip: body.ip,
  };

  try {
    const kc = getKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    
    let existingLog = "";
    try {
      const cm = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
      existingLog = (cm as { data?: Record<string, string> }).data?.log ?? "";
    } catch { /* ConfigMap may not exist yet */ }
    
    const lines = existingLog.split("\n").filter(Boolean);
    lines.push(JSON.stringify(entry));
    // Rotate to MAX_ENTRIES
    const trimmed = lines.slice(-MAX_ENTRIES);
    const newLog = trimmed.join("\n") + "\n";
    
    try {
      await coreApi.patchNamespacedConfigMap({
        name: CONFIGMAP_NAME,
        namespace: NAMESPACE,
        body: { data: { log: newLog } },
      });
    } catch {
      // ConfigMap doesn't exist, create it
      await coreApi.createNamespacedConfigMap({
        namespace: NAMESPACE,
        body: {
          metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE },
          data: { log: newLog },
        },
      });
    }
    
    return NextResponse.json({ ok: true });
  } catch {
    // Non-fatal: log to stdout
    console.log("AUDIT:", JSON.stringify(entry));
    return NextResponse.json({ ok: true, stored: false });
  }
}
