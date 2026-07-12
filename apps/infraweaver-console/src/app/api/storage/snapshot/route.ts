import { NextResponse } from "next/server";
import { z } from "zod";
import { validateK8sName, validateK8sNamespace } from "@/lib/api-security";
import { auditLog } from "@/lib/audit-log";
import { safeError } from "@/lib/utils";
import { makeCustomApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";

const snapshotBodySchema = z.object({
  pvcName: z.string().min(1),
  namespace: z.string().min(1),
});

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "storage-snapshot", limit: 10, windowMs: 60_000 } },
  async ({ req, session }) => {
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
      const customApi = makeCustomApi();
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
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
