import { NextResponse } from "next/server";
import { z } from "zod";
import { argocdFetch } from "@/lib/argocd-apps";
import { validateK8sName } from "@/lib/api-security";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { withAuth } from "@/lib/with-auth";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const syncBodySchema = z.object({
  hard: z.boolean().optional(),
});

export const POST = withAuth<{ name: string }>(
  { permission: "apps:sync", rateLimit: { name: "argocd-sync", limit: 10, windowMs: 60_000 } },
  async ({ req, session, params }) => {
    const { name } = params;
    const nameErr = validateK8sName(name);
    if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
    if (!SAFE_NAME_RE.test(name)) {
      return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
    }

    const rawBody = await req.json().catch(() => ({}));
    const bodyParsed = syncBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      return NextResponse.json({ error: "Validation failed", details: bodyParsed.error.flatten() }, { status: 400 });
    }
    const { hard } = bodyParsed.data;
    try {
      const body = hard
        ? { revision: "HEAD", prune: false, strategy: { hook: {}, apply: { force: true } } }
        : { revision: "HEAD", prune: false };
      const res = await argocdFetch(`/api/v1/applications/${name}/sync`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await auditLog(
        "argocd:sync",
        session.user?.email ?? "unknown",
        `app=${name} hard=${Boolean(hard)}`
      );
      if (!res.ok) return NextResponse.json({ ok: false, error: "ArgoCD unavailable" }, { status: 503 });
      invalidateArgocdCaches();
      return NextResponse.json(await res.json());
    } catch {
      return NextResponse.json({ ok: false, error: "ArgoCD unavailable" }, { status: 503 });
    }
  },
);
