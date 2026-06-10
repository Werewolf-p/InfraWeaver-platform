import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";
import { withRoute } from "@/lib/route-utils";

const payloadSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
});

export const POST = withRoute("cluster:admin", async (req: NextRequest, session) => {
  if (!checkRateLimit(rateLimitKey("pod-restart", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = payloadSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name } = parsed.data;
  const clusterId = getRequestClusterId(req);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.deleteNamespacedPod({ namespace, name });
    await auditLog("pod:restart", session.user?.email ?? "unknown", `restarted pod ${namespace}/${name}`);
    invalidatePodCaches();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
});
