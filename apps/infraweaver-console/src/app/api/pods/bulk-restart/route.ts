import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { makeCoreApi } from "@/lib/kube-client";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { requireSingleCluster, withRoute } from "@/lib/route-utils";
import { restartPodSafely } from "../restart-pod";

const payloadSchema = z.object({
  pods: z.array(z.object({
    namespace: z.string().min(1).max(253),
    name: z.string().min(1).max(253),
  })).min(1).max(20),
  // Bypass the installing-pod guard for a deliberate operator restart.
  force: z.boolean().optional(),
});

export const POST = withRoute("cluster:admin", async (req: NextRequest, session) => {
  if (!checkRateLimit(rateLimitKey("pod-bulk-restart", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = payloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const uniquePods = Array.from(new Map(
    parsed.data.pods.map((pod) => [`${pod.namespace}/${pod.name}`, pod]),
  ).values());

  const cluster = requireSingleCluster(req);
  if (cluster instanceof NextResponse) return cluster;

  try {
    const coreApi = makeCoreApi(cluster.clusterId);
    const failures: Array<{ namespace: string; name: string; error: string }> = [];
    const skippedInstalling: Array<{ namespace: string; name: string }> = [];

    for (const pod of uniquePods) {
      try {
        const outcome = await restartPodSafely(coreApi, pod, parsed.data.force);
        if (outcome === "skipped-installing") {
          skippedInstalling.push({ namespace: pod.namespace, name: pod.name });
        }
      } catch (error) {
        failures.push({
          namespace: pod.namespace,
          name: pod.name,
          error: error instanceof Error ? error.message : "Failed to restart pod",
        });
      }
    }

    const restartedCount = uniquePods.length - failures.length - skippedInstalling.length;
    await auditLog(
      "pod:restart:bulk",
      session.user?.email ?? "unknown",
      `restarted ${restartedCount}/${uniquePods.length} pods` +
        (skippedInstalling.length ? ` (${skippedInstalling.length} skipped: installing)` : ""),
    );
    if (restartedCount > 0) invalidatePodCaches();

    return NextResponse.json({
      ok: failures.length === 0,
      restartedCount,
      total: uniquePods.length,
      skippedInstalling,
      failures,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
  }
});
