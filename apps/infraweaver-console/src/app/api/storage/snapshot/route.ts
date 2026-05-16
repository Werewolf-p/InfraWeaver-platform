import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { validateK8sName, validateK8sNamespace } from "@/lib/api-security";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import * as k8s from "@kubernetes/client-node";

const snapshotBodySchema = z.object({
  pvcName: z.string().min(1),
  namespace: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rawBody = await req.json().catch(() => ({}));
  const parsed = snapshotBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { pvcName, namespace } = parsed.data;
  const nsErr = validateK8sNamespace(namespace);
  if (nsErr) return NextResponse.json(nsErr.error, { status: nsErr.status });
  const nameErr = validateK8sName(pvcName);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const snapshotName = `${pvcName}-snapshot-${Date.now()}`;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.createNamespacedCustomObject({
      group: "snapshot.storage.k8s.io", version: "v1", plural: "volumesnapshots", namespace,
      body: {
        apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot",
        metadata: { name: snapshotName, namespace },
        spec: { volumeSnapshotClassName: "longhorn", source: { persistentVolumeClaimName: pvcName } },
      },
    });
    await auditLog("storage:snapshot", session.user?.email ?? "unknown", `created snapshot ${namespace}/${snapshotName}`);
    return NextResponse.json({ ok: true, snapshotName });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
}
