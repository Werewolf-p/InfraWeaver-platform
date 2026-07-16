import { NextResponse } from "next/server";
import { validateK8sName } from "@/lib/api-security";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { argocdApiBase } from "@/lib/platform-config";
import { withAuth } from "@/lib/with-auth";

const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const DELETE = withAuth<{ name: string }>(
  // Deleting an ArgoCD Application issues a real cascading DELETE, so it must
  // require apps:delete — matching the backend's dedicated DELETE /argocd/apps/:name
  // route and the bulk-remove BFLA guard (infraweaver-api argocd.ts). apps:sync
  // (held by platform-operator/developer, roles NOT allowed to delete apps) is
  // too weak: it let an operator delete any Application through this path.
  { permission: "apps:delete", rateLimit: { name: "argocd-delete", limit: 5, windowMs: 60_000 } },
  async ({ session, params }) => {
    const { name } = params;
    const nameErr = validateK8sName(name);
    if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
    if (!SAFE_NAME_RE.test(name)) {
      return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
    }

    const res = await fetch(`${argocdApiBase()}/api/v1/applications/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`ArgoCD delete failed: ${res.status}`);
    await auditLog("argocd:delete", session.user?.email ?? "unknown", `app=${name}`);
    invalidateArgocdCaches();
    return NextResponse.json({ ok: true });
  },
);
