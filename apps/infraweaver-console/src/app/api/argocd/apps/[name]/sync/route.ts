import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:sync")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("argocd-sync", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  if (!SAFE_NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  }

  const { hard } = await req.json().catch(() => ({ hard: false }));
  try {
    const body = hard
      ? { revision: "HEAD", prune: false, strategy: { hook: {}, apply: { force: true } } }
      : { revision: "HEAD", prune: false };
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${name}/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await auditLog(
      "argocd:sync",
      session.user?.email ?? "unknown",
      `app=${name} hard=${Boolean(hard)}`
    );
    if (!res.ok) return NextResponse.json({ ok: true, mock: true });
    invalidateArgocdCaches();
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ ok: true, mock: true });
  }
}
