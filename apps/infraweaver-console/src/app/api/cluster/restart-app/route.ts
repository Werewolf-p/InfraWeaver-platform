import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { makeAppsApi } from "@/lib/kube-client";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { requireSingleCluster } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

const RestartAppBody = z.object({
  namespace: z.string().min(1).max(63),
  appName: z.string().min(1).max(253),
});

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-restart-app", limit: 10, windowMs: 60_000 } },
  async ({ req, session }) => {
    const result = RestartAppBody.safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
    const { namespace, appName } = result.data;
    if (!isValidNamespace(namespace) || !isValidK8sName(appName)) {
      return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
    }
    const cluster = requireSingleCluster(req);
    if (cluster instanceof NextResponse) return cluster;
    try {
      await makeAppsApi(cluster.clusterId).patchNamespacedDeployment({
        name: appName, namespace,
        body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
      });
      await auditLog("cluster:restart-app", session.user?.email ?? "unknown", `restarted ${namespace}/${appName}`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
