import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-cordon", limit: 10, windowMs: 60_000 } },
  async ({ req, session }) => {
    const result = z.object({ node: z.string().min(1).max(253), cordon: z.boolean() }).safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

    const { node, cordon } = result.data;
    const clusterId = getRequestClusterId(req);
    if (clusterId === "all") {
      return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
    }
    try {
      const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
      await coreApi.patchNode({ name: node, body: { spec: { unschedulable: cordon } } });
      await auditLog(cordon ? "cluster:cordon" : "cluster:uncordon", session.user?.email ?? "unknown", `${cordon ? "cordoned" : "uncordoned"} node ${node}`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
    }
  },
);
