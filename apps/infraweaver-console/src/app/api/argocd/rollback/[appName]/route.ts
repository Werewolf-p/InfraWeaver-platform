import { NextResponse } from "next/server";
import { argocdFetch } from "@/lib/argocd-apps";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { isValidK8sName } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

export const POST = withAuth<{ appName: string }>(
  { permission: "apps:sync", rateLimit: { name: "argocd-rollback", limit: 5, windowMs: 60_000 } },
  async ({ req, session, params }) => {
    const { appName } = params;
    if (!isValidK8sName(appName)) return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
    const RollbackBody = z.object({ revision: z.number().int().min(0) });
    const result = RollbackBody.safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
    const { revision } = result.data;
    try {
      const res = await argocdFetch(`/api/v1/applications/${appName}/rollback`, {
        method: "POST",
        body: JSON.stringify({ id: revision }),
      });
      if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
      await auditLog("argocd:rollback", session.user?.email ?? "unknown", `rolled back ${appName} to revision ${revision}`);
      invalidateArgocdCaches();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
    }
  },
);
