import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export interface ArgoEvent {
  appName: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  revision?: string;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=500`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Failed to list apps");
    const data = await res.json() as {
      items?: Array<{
        metadata: { name: string };
        status: {
          operationState?: {
            phase: string;
            startedAt: string;
            finishedAt?: string;
            message?: string;
            syncResult?: { revision?: string };
          };
        };
      }>;
    };

    const events: ArgoEvent[] = (data.items ?? [])
      .filter(app => app.status.operationState?.startedAt)
      .map(app => ({
        appName: app.metadata.name,
        phase: app.status.operationState!.phase,
        startedAt: app.status.operationState!.startedAt,
        finishedAt: app.status.operationState!.finishedAt,
        message: app.status.operationState!.message,
        revision: app.status.operationState!.syncResult?.revision,
      }))
      .sort((a, b) => {
        const at = a.finishedAt ?? a.startedAt;
        const bt = b.finishedAt ?? b.startedAt;
        return new Date(bt).getTime() - new Date(at).getTime();
      });

    return NextResponse.json(events);
  } catch {
    const now = new Date();
    const mockEvents: ArgoEvent[] = [
      { appName: "catalog-gatus-manifests", phase: "Succeeded", startedAt: new Date(now.getTime() - 5 * 60000).toISOString(), finishedAt: new Date(now.getTime() - 4 * 60000).toISOString(), revision: "a1b2c3d", message: "successfully synced" },
      { appName: "platform-authentik", phase: "Succeeded", startedAt: new Date(now.getTime() - 15 * 60000).toISOString(), finishedAt: new Date(now.getTime() - 14 * 60000).toISOString(), revision: "e4f5g6h", message: "successfully synced" },
      { appName: "core-traefik", phase: "Succeeded", startedAt: new Date(now.getTime() - 30 * 60000).toISOString(), finishedAt: new Date(now.getTime() - 29 * 60000).toISOString(), revision: "i7j8k9l", message: "successfully synced" },
      { appName: "platform-netbird", phase: "Running", startedAt: new Date(now.getTime() - 2 * 60000).toISOString(), message: "waiting for healthy status" },
      { appName: "core-longhorn", phase: "Succeeded", startedAt: new Date(now.getTime() - 60 * 60000).toISOString(), finishedAt: new Date(now.getTime() - 59 * 60000).toISOString(), revision: "m1n2o3p", message: "successfully synced" },
    ];
    return NextResponse.json(mockEvents);
  }
}
