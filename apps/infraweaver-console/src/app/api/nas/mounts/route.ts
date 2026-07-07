// GET /api/nas/mounts — enumerate every NAS-backed volume in the cluster and
// resolve the pod that consumes it.
//
// Plan reference: plans/advanced-storage.md §4 ("Mounts table") and §7 Phase 2.
// This powers the "NAS & external" section of the Storage page so an operator
// can see, at a glance, which app in which namespace is mounting which share
// on the NAS, and with what access mode.
//
// Discovery model (label-driven, not name-driven):
//   1. List every PVC in every namespace with label
//      `infraweaver.io/nas-share=true` (emitted by `generateK8sManifest`).
//   2. Resolve the bound StorageClass → source (`//host/share`), subDir.
//   3. Enumerate pods in each PVC's namespace and match on `volumes[].pvc`.
//   4. Detect the effective read-only mode from the SC `mountOptions` + the
//      pod's `volumeMounts[].readOnly` flag.

import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import * as k8s from "@kubernetes/client-node";

interface NasMount {
  pvcName: string;
  pvcNamespace: string;
  storageClass: string;
  provider: string;
  user: string;
  access: "ro" | "rw";
  source: string | null;
  subDir: string | null;
  pod: string | null;
  podPhase: string | null;
  mountPath: string | null;
  mountReadOnly: boolean | null;
  phase: string | null;
}

interface PvcResource {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { storageClassName?: string; volumeName?: string };
  status?: { phase?: string };
}

interface StorageClassResource {
  metadata?: { name?: string };
  mountOptions?: string[];
  parameters?: Record<string, string>;
}

interface PodResource {
  metadata?: { name?: string; namespace?: string };
  status?: { phase?: string };
  spec?: {
    volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>;
    containers?: Array<{ volumeMounts?: Array<{ name?: string; mountPath?: string; readOnly?: boolean }> }>;
  };
}

export const GET = withAuth({ permission: "nas:read", rateLimit: { name: "nas-mounts", limit: 30, windowMs: 60_000 } }, async ({ req }) => {
  try {
    const kc = loadKubeConfig(getRequestClusterId(req));
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    const [pvcResp, scResp] = await Promise.all([
      coreApi.listPersistentVolumeClaimForAllNamespaces({
        labelSelector: "infraweaver.io/nas-share=true",
      }),
      storageApi.listStorageClass(),
    ]);
    const pvcs = ((pvcResp as { items?: PvcResource[] }).items ?? []);
    const scs = ((scResp as { items?: StorageClassResource[] }).items ?? []);
    const scByName = new Map(scs.map((sc) => [sc.metadata?.name ?? "", sc]));

    // Group PVCs by namespace so we page pods once per namespace.
    const nsToPvcs = new Map<string, PvcResource[]>();
    for (const pvc of pvcs) {
      const ns = pvc.metadata?.namespace;
      if (!ns) continue;
      const list = nsToPvcs.get(ns) ?? [];
      list.push(pvc);
      nsToPvcs.set(ns, list);
    }
    const podsByNs = new Map<string, PodResource[]>();
    await Promise.all(
      [...nsToPvcs.keys()].map(async (ns) => {
        try {
          const resp = await coreApi.listNamespacedPod({ namespace: ns });
          podsByNs.set(ns, ((resp as { items?: PodResource[] }).items ?? []));
        } catch {
          podsByNs.set(ns, []);
        }
      }),
    );

    const mounts: NasMount[] = [];
    for (const pvc of pvcs) {
      const ns = pvc.metadata?.namespace ?? "";
      const pvcName = pvc.metadata?.name ?? "";
      const scName = pvc.spec?.storageClassName ?? "";
      const sc = scByName.get(scName);
      const labels = pvc.metadata?.labels ?? {};
      const explicitAccess = labels["infraweaver.io/access"] as "ro" | "rw" | undefined;
      const scReadOnly = Boolean(sc?.mountOptions?.includes("ro"));

      const bindings = (podsByNs.get(ns) ?? []).flatMap<{ pod: PodResource; volName: string; mount?: { mountPath?: string; readOnly?: boolean } }>((pod) => {
        const volNames = (pod.spec?.volumes ?? [])
          .filter((vol) => vol.persistentVolumeClaim?.claimName === pvcName)
          .map((vol) => vol.name ?? "");
        return volNames.map((volName) => {
          const mount = (pod.spec?.containers ?? [])
            .flatMap((container) => container.volumeMounts ?? [])
            .find((vm) => vm.name === volName);
          return { pod, volName, mount };
        });
      });

      const base = {
        pvcName,
        pvcNamespace: ns,
        storageClass: scName,
        provider: labels["infraweaver.io/provider"] ?? "unknown",
        user: labels["infraweaver.io/user"] ?? "",
        source: sc?.parameters?.source ?? null,
        subDir: sc?.parameters?.subDir ?? null,
        phase: pvc.status?.phase ?? null,
      };

      if (bindings.length === 0) {
        mounts.push({
          ...base,
          access: explicitAccess ?? (scReadOnly ? "ro" : "rw"),
          pod: null,
          podPhase: null,
          mountPath: null,
          mountReadOnly: null,
        });
        continue;
      }
      for (const binding of bindings) {
        const mountRO = binding.mount?.readOnly ?? null;
        // Effective RO = SC-level RO OR pod-level RO. RW only when both are false.
        const effectiveAccess: "ro" | "rw" = (scReadOnly || mountRO === true)
          ? "ro"
          : (explicitAccess ?? "rw");
        mounts.push({
          ...base,
          access: effectiveAccess,
          pod: binding.pod.metadata?.name ?? null,
          podPhase: binding.pod.status?.phase ?? null,
          mountPath: binding.mount?.mountPath ?? null,
          mountReadOnly: mountRO,
        });
      }
    }

    mounts.sort((a, b) => (a.pvcNamespace + a.pvcName).localeCompare(b.pvcNamespace + b.pvcName));
    return NextResponse.json({ mounts });
  } catch (error) {
    return NextResponse.json({ error: safeError(error), mounts: [] }, { status: 500 });
  }
});
