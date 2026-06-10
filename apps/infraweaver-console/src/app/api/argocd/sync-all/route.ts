import { NextResponse } from "next/server";
import { argocdFetch } from "@/lib/argocd-apps";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth(
  { permission: "apps:sync", rateLimit: { name: "argocd-sync-all", limit: 10, windowMs: 60_000 } },
  async ({ session }) => {
    const listRes = await argocdFetch("/api/v1/applications?limit=500", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!listRes.ok) {
      const error = `Failed to list apps: ${listRes.status}`;
      await auditLog("argocd:sync-all", session.user?.email ?? "unknown", `synced=0 errors=1 fallback=${error}`);
      return NextResponse.json({ error: "ArgoCD unavailable", synced: [], errors: [error], total: 0 }, { status: 503 });
    }
    const data = await listRes.json() as { items?: Array<{ metadata: { name: string }; status: { sync: { status: string } } }> };
    const apps = data.items ?? [];
    const outOfSync = apps.filter(a => a.status.sync.status === "OutOfSync");

    const synced: string[] = [];
    const errors: string[] = [];

    await Promise.all(
      outOfSync.map(async (app) => {
        try {
          const syncRes = await argocdFetch(
            `/api/v1/applications/${app.metadata.name}/sync`,
            {
              method: "POST",
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(5000),
            }
          );
          if (!syncRes.ok) throw new Error(`Sync failed: ${syncRes.status}`);
          synced.push(app.metadata.name);
        } catch (e) {
          errors.push(`${app.metadata.name}: ${safeError(e)}`);
        }
      })
    );

    await auditLog(
      "argocd:sync-all",
      session.user?.email ?? "unknown",
      `synced=${synced.length} errors=${errors.length}`
    );
    if (synced.length > 0) invalidateArgocdCaches();
    return NextResponse.json({ synced, errors, total: outOfSync.length });
  },
);
