import "server-only";
import { makeCoreApi } from "@/lib/kube-client";

/**
 * PVC-expand primitive — SERVER ONLY.
 *
 * Extracted from `POST/PATCH /api/storage/expand` so the same choke point can be
 * reused by the self-service approval executor (see lib/self-service/apply.ts).
 * The patch itself is a `cluster:admin`-gated operation; this helper does NOT
 * authorize — callers must enforce their own permission gate first.
 */

/** Kubernetes quantity shape accepted for a PVC storage request (Ki…Pi). */
export const PVC_SIZE_RE = /^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi)$/;

export interface ExpandPvcInput {
  /** Multi-cluster support; omitted = the console's own cluster (unchanged default). */
  clusterId?: string;
  namespace: string;
  name: string;
  /** New requested size, e.g. "20Gi". Must match {@link PVC_SIZE_RE}. */
  newSize: string;
}

export interface ExpandedPvcSummary {
  namespace: string;
  name: string;
  requestedStorage: string;
  capacity: string;
}

/**
 * Patch a PVC's requested storage and return its post-patch summary. Throws on
 * an API error (the caller maps it to a 502) — expansion is only ever additive
 * (Kubernetes rejects a shrink), so a failure never partially applies.
 */
export async function expandPvc(input: ExpandPvcInput): Promise<ExpandedPvcSummary> {
  const { clusterId, namespace, name, newSize } = input;
  const coreApi = makeCoreApi(clusterId);

  await coreApi.patchNamespacedPersistentVolumeClaim({
    name,
    namespace,
    body: { spec: { resources: { requests: { storage: newSize } } } },
    fieldManager: "infraweaver",
  });

  const pvc = await coreApi.readNamespacedPersistentVolumeClaim({ name, namespace });
  return {
    namespace,
    name,
    requestedStorage: pvc.spec?.resources?.requests?.storage ?? newSize,
    capacity: pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage ?? newSize,
  };
}
