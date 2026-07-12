import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { makeCoreApi } from "@/lib/kube-client";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { safeError } from "@/lib/utils";
import { z } from "zod";
import { requireSingleCluster, withRoute } from "@/lib/route-utils";
import { restartPodSafely } from "../restart-pod";

const payloadSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  // Bypass the installing-pod guard for a deliberate operator restart of a
  // stuck install. Off by default so automated/repeated restarts never churn.
  force: z.boolean().optional(),
});

export const POST = withRoute("cluster:admin", async (req: NextRequest, session) => {
  if (!checkRateLimit(rateLimitKey("pod-restart", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = payloadSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name, force } = parsed.data;
  const cluster = requireSingleCluster(req);
  if (cluster instanceof NextResponse) return cluster;

  try {
    const outcome = await restartPodSafely(makeCoreApi(cluster.clusterId), { namespace, name }, force);
    if (outcome === "skipped-installing") {
      return NextResponse.json({ ok: true, restarted: false, skippedInstalling: true });
    }

    await auditLog("pod:restart", session.user?.email ?? "unknown", `restarted pod ${namespace}/${name}`);
    invalidatePodCaches();
    return NextResponse.json({ ok: true, restarted: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
  }
});
