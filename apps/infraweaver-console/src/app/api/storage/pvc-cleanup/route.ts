import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/with-auth";
import { safeError } from "@/lib/utils";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import { makeCoreApi } from "@/lib/kube-client";

const pvcCleanupSchema = z.object({
  pvcs: z.array(z.object({ namespace: z.string().min(1), name: z.string().min(1) })).min(1),
});

export const GET = withAuth({ permission: ["cluster:read", "infra:read"] }, async () => {
  try {
    const coreApi = makeCoreApi();
    const res = await coreApi.listPersistentVolumeClaimForAllNamespaces();

    const unused = res.items
      .filter(pvc => (pvc.status?.phase ?? "") !== "Bound")
      .map(pvc => ({
        namespace: pvc.metadata?.namespace ?? "",
        name: pvc.metadata?.name ?? "",
        status: pvc.status?.phase ?? "Unknown",
        storageClass: pvc.spec?.storageClassName ?? "",
        capacity: pvc.spec?.resources?.requests?.storage ?? pvc.status?.capacity?.storage ?? "",
        createdAt: pvc.metadata?.creationTimestamp
          ? new Date(pvc.metadata.creationTimestamp as string | Date).toISOString()
          : null,
      }));

    return NextResponse.json({ unused });
  } catch (err) {
    console.error("[pvc-cleanup] GET failed:", err);
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
});

export const DELETE = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "storage-pvc-cleanup", limit: 10, windowMs: 60_000 } },
  async ({ req }) => {
    const rawBody = await req.json().catch(() => ({}));
    const parsed = pvcCleanupSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.pvcs.some((pvc) => !isValidNamespace(pvc.namespace) || !isValidK8sName(pvc.name))) {
      return NextResponse.json({ error: "Invalid PVC name" }, { status: 400 });
    }
    const { pvcs } = parsed.data;

    const coreApi = makeCoreApi();
    const results: Array<{ namespace: string; name: string; success: boolean; error?: string }> = [];

    for (const { namespace, name } of pvcs) {
      try {
        await coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace });
        results.push({ namespace, name, success: true });
      } catch (err) {
        console.error(`[pvc-cleanup] failed to delete ${namespace}/${name}:`, err);
        results.push({ namespace, name, success: false, error: safeError(err) });
      }
    }

    const failed = results.filter(r => !r.success);
    return NextResponse.json({
      results,
      deleted: results.filter(r => r.success).length,
      failed: failed.length,
    }, { status: failed.length > 0 && failed.length === results.length ? 500 : 200 });
  },
);
