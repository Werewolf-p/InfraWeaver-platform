import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

function makeKc(clusterId: string) {
  return loadKubeConfig(clusterId);
}

export const PATCH = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-scale", limit: 20, windowMs: 60_000 } },
  async ({ req, session }) => {
    const result = z.object({
      namespace: z.string().min(1).max(63),
      deployment: z.string().min(1).max(253),
      replicas: z.number().int().min(0).max(20),
    }).safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

    const { namespace, deployment, replicas } = result.data;
    if (!isValidNamespace(namespace) || !isValidK8sName(deployment)) {
      return NextResponse.json({ error: "Invalid deployment name" }, { status: 400 });
    }
    const clusterId = getRequestClusterId(req);
    if (clusterId === "all") {
      return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
    }
    try {
      const appsApi = makeKc(clusterId).makeApiClient(k8s.AppsV1Api);
      const scale = await appsApi.readNamespacedDeploymentScale({ name: deployment, namespace });
      await appsApi.replaceNamespacedDeploymentScale({
        name: deployment,
        namespace,
        body: { ...scale, spec: { ...(scale.spec ?? {}), replicas } },
      });
      await auditLog("cluster:scale", session.user?.email ?? "unknown", `scaled ${namespace}/${deployment} to ${replicas}`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true, replicas });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
    }
  },
);

export const GET = withAuth(
  { permission: ["cluster:read", "infra:read"] },
  async ({ req }) => {
    const namespace = req.nextUrl.searchParams.get("namespace") ?? "";
    const deployment = req.nextUrl.searchParams.get("deployment") ?? "";
    if (!namespace || !deployment) return NextResponse.json({ error: "namespace and deployment required" }, { status: 400 });
    if (!isValidNamespace(namespace) || !isValidK8sName(deployment)) {
      return NextResponse.json({ error: "Invalid deployment name" }, { status: 400 });
    }

    try {
      const appsApi = makeKc(getRequestClusterId(req)).makeApiClient(k8s.AppsV1Api);
      const dep = await appsApi.readNamespacedDeployment({ name: deployment, namespace });
      return NextResponse.json({ replicas: dep.spec?.replicas ?? 1 });
    } catch {
      return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
    }
  },
);
