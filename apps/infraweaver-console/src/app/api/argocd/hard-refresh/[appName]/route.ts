import { NextResponse } from "next/server";
import { argocdFetch } from "@/lib/argocd-apps";
import { validateK8sName } from "@/lib/api-security";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth<{ appName: string }>(
  { permission: "apps:sync", rateLimit: { name: "argocd-hard-refresh", limit: 10, windowMs: 60_000 } },
  async ({ session, params }) => {
    const { appName } = params;
    const nameErr = validateK8sName(appName);
    if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
    try {
      const res = await argocdFetch(`/api/v1/applications/${appName}/sync`, {
        method: "POST",
        body: JSON.stringify({ hardRefresh: true }),
      });
      if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
      await auditLog("argocd:hard-refresh", session.user?.email ?? "unknown", `hard refresh ${appName}`);
      invalidateArgocdCaches();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
    }
  },
);
