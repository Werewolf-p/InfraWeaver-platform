import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { getRequestClusterId } from "@/lib/cluster-context";
import { requireRoutePermissions } from "@/lib/route-utils";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

const expandSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  newSize: z.string().min(2).max(32).regex(/^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi)$/),
});

export async function PATCH(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const parsed = expandSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name, newSize } = parsed.data;
  const clusterId = getRequestClusterId(request);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNamespacedPersistentVolumeClaim({
      name,
      namespace,
      body: { spec: { resources: { requests: { storage: newSize } } } },
      fieldManager: "infraweaver",
    });

    const pvc = await coreApi.readNamespacedPersistentVolumeClaim({ name, namespace });
    return NextResponse.json({
      ok: true,
      pvc: {
        namespace,
        name,
        requestedStorage: pvc.spec?.resources?.requests?.storage ?? newSize,
        capacity: pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage ?? newSize,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: safeError(error),
    });
  }
}
