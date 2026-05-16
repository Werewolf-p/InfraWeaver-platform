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

type ArgoEventsResponse = { events: ArgoEvent[] } | { error: string; events: [] };

export async function GET(): Promise<NextResponse<ArgoEventsResponse>> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized", events: [] }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden", events: [] }, { status: 403 });
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

    return NextResponse.json({ events });
  } catch {
    return NextResponse.json({ error: "ArgoCD unavailable", events: [] }, { status: 503 });
  }
}
