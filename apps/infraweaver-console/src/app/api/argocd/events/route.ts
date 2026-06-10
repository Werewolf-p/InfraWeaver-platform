import { NextResponse } from "next/server";
import { argocdFetch } from "@/lib/argocd-apps";
import { withAuth } from "@/lib/with-auth";

export interface ArgoEvent {
  appName: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  revision?: string;
}

export const GET = withAuth(
  { permission: "apps:read" },
  async () => {
    try {
      const res = await argocdFetch("/api/v1/applications?limit=500", {
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
  },
);
