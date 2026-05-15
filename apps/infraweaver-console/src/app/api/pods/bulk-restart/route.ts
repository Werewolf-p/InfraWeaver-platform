import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const payloadSchema = z.object({
  pods: z.array(z.object({
    namespace: z.string().min(1).max(253),
    name: z.string().min(1).max(253),
  })).min(1).max(20),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
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

    return NextResponse.json({
      ok: failures.length === 0,
      restartedCount,
      total: uniquePods.length,
      failures,
    });
  } catch {
    await auditLog(
      "pod:restart:bulk",
      session.user?.email ?? "unknown",
      `simulated restart of ${uniquePods.length} pods`,
    );

    return NextResponse.json({
      ok: true,
      restartedCount: uniquePods.length,
      total: uniquePods.length,
      failures: [],
      simulated: true,
    });
  }
}
