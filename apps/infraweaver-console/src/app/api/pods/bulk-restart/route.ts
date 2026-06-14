import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";

const payloadSchema = z.object({
  pods: z.array(z.object({
    namespace: z.string().min(1).max(253),
    name: z.string().min(1).max(253),
  })).min(1).max(20),
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

  const clusterId = getRequestClusterId(req);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    const failures: Array<{ namespace: string; name: string; error: string }> = [];

    for (const pod of uniquePods) {
      try {
        await coreApi.deleteNamespacedPod({ namespace: pod.namespace, name: pod.name });
      } catch (error) {
        failures.push({
          namespace: pod.namespace,
          name: pod.name,
          error: error instanceof Error ? error.message : "Failed to restart pod",
        });
      }
    }

    const restartedCount = uniquePods.length - failures.length;
    await auditLog(
      "pod:restart:bulk",
      session.user?.email ?? "unknown",
      `restarted ${restartedCount}/${uniquePods.length} pods`,
    );
    if (restartedCount > 0) invalidatePodCaches();

    return NextResponse.json({
      ok: failures.length === 0,
      restartedCount,
      total: uniquePods.length,
      failures,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Operation failed" },
      { status: 502 },
    );
  }
});
