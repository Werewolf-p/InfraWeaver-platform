import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth(
  { permission: "config:write", rateLimit: { name: "config-reload", limit: 10, windowMs: 60_000 } },
  async ({ session }) => {
    const server = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local";
    const token = process.env.ARGOCD_TOKEN ?? "";
    const appName = process.env.ARGOCD_APP_OF_APPS ?? "app-of-apps";
    try {
      const res = await fetch(`${server}/api/v1/applications/${appName}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
      await auditLog("config:reload", session.user?.email ?? "unknown", `triggered hot-reload of ${appName}`);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
