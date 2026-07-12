import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { makeAppsApi } from "@/lib/kube-client";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { requireSingleCluster } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-rolling-restart", limit: 3, windowMs: 60_000 } },
  async ({ req, session }) => {
    const result = z.object({ namespace: z.string().min(1).max(63) }).safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

    const { namespace } = result.data;
    const restarted: string[] = [];
    const errors: string[] = [];

    const cluster = requireSingleCluster(req);
    if (cluster instanceof NextResponse) return cluster;

    try {
      const appsApi = makeAppsApi(cluster.clusterId);
      const deployments = await appsApi.listNamespacedDeployment({ namespace });
      for (const deployment of deployments.items) {
        const name = deployment.metadata?.name ?? "";
        try {
          await appsApi.patchNamespacedDeployment({
            name,
            namespace,
            body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
          });
          restarted.push(name);
        } catch (error) {
          errors.push(`${name}: ${safeError(error)}`);
        }
      }
      await auditLog("cluster:rolling-restart", session.user?.email ?? "unknown", `rolling restart in ${namespace}: ${restarted.join(", ")}`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true, restarted, errors });
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
