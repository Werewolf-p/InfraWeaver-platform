import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const payloadSchema = z.object({
  cordon: z.boolean(),
});

async function updateMaintenanceMode(request: NextRequest, paramsPromise: Promise<{ name: string }>) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("cluster-node-cordon", request), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = payloadSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { name } = await paramsPromise;
  const { cordon } = parsed.data;
  const clusterId = getRequestClusterId(request);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNode({
      name,
      body: { spec: { unschedulable: cordon } },
      fieldManager: "infraweaver",
    });
    await auditLog(
      cordon ? "cluster:cordon" : "cluster:uncordon",
      session.user?.email ?? "unknown",
      `${cordon ? "enabled" : "disabled"} maintenance mode for node ${name}`,
    );
    return NextResponse.json({ ok: true, node: name, cordon });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  return updateMaintenanceMode(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  return updateMaintenanceMode(request, params);
}
