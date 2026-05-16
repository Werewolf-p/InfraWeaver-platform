import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { safeError } from "@/lib/utils";

const ARGOCD_URL = process.env.ARGOCD_URL ?? "https://argocd.int.rlservers.com";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:sync")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("argocd-delete", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  if (!SAFE_NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  }

  try {
    const res = await fetch(`${ARGOCD_URL}/api/v1/applications/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`ArgoCD delete failed: ${res.status}`);
    await auditLog(
      "argocd:delete",
      session.user?.email ?? "unknown",
      `app=${name}`
    );
    invalidateArgocdCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
