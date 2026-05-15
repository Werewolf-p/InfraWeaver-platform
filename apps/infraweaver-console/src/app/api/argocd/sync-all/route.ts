import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { safeError } from "@/lib/utils";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:sync")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("argocd-sync-all", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const listRes = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=500`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!listRes.ok) throw new Error("Failed to list apps");
    const data = await listRes.json() as { items?: Array<{ metadata: { name: string }; status: { sync: { status: string } } }> };
    const apps = data.items ?? [];
    const outOfSync = apps.filter(a => a.status.sync.status === "OutOfSync");

    const synced: string[] = [];
    const errors: string[] = [];

    await Promise.all(
      outOfSync.map(async (app) => {
        try {
          const syncRes = await fetch(
            `${ARGOCD_SERVER}/api/v1/applications/${app.metadata.name}/sync`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ARGOCD_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
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
    return NextResponse.json({ synced, errors, total: outOfSync.length });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
