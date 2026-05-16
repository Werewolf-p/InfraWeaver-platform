import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { getRequestClusterId } from "@/lib/cluster-context";
import { requireRoutePermissions } from "@/lib/route-utils";
import { loadKubeConfig } from "@/lib/k8s";

const LONGHORN_API = process.env.LONGHORN_API ?? "http://longhorn-frontend.longhorn-system.svc.cluster.local:80";

interface LonghornVolume {
  name: string;
  robustness: string | null;
  state: string | null;
  kubernetesStatus?: {
    namespace?: string;
    pvcName?: string;
    pvName?: string;
  };
}

function pvcKey(namespace: string, name: string) {
  return `${namespace}/${name}`;
}

async function loadLonghornVolumes(): Promise<{ volumes: LonghornVolume[]; live: boolean }> {
  try {
    const response = await fetch(`${LONGHORN_API}/v1/volumes`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) throw new Error("Longhorn API error");

    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    const volumes = (payload.data ?? []).map((volume) => ({
      name: typeof volume.name === "string" ? volume.name : "",
      robustness: typeof volume.robustness === "string" ? volume.robustness : null,
      state: typeof volume.state === "string" ? volume.state : null,
      kubernetesStatus: volume.kubernetesStatus as LonghornVolume["kubernetesStatus"],
    }));

    return { volumes, live: true };
  } catch {
    return {
      live: false,
      volumes: [
        { name: "pv-data-01", robustness: "healthy", state: "attached", kubernetesStatus: { namespace: "default", pvcName: "data-pvc", pvName: "pv-data-01" } },
        { name: "pv-monitoring-01", robustness: "degraded", state: "attached", kubernetesStatus: { namespace: "monitoring", pvcName: "prometheus-pvc", pvName: "pv-monitoring-01" } },
      ],
    };
  }
}

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  try {
    const coreApi = loadKubeConfig(getRequestClusterId(request)).makeApiClient(k8s.CoreV1Api);
    const [{ volumes: longhornVolumes, live }, pvsRes, pvcsRes] = await Promise.all([
      loadLonghornVolumes(),
      coreApi.listPersistentVolume(),
      coreApi.listPersistentVolumeClaimForAllNamespaces(),
    ]);

    const longhornByPv = new Map<string, LonghornVolume>();
    const longhornByPvc = new Map<string, LonghornVolume>();
    for (const volume of longhornVolumes) {
      if (volume.kubernetesStatus?.pvName) longhornByPv.set(volume.kubernetesStatus.pvName, volume);
      if (volume.kubernetesStatus?.namespace && volume.kubernetesStatus?.pvcName) {
        longhornByPvc.set(pvcKey(volume.kubernetesStatus.namespace, volume.kubernetesStatus.pvcName), volume);
      }
      longhornByPv.set(volume.name, volume);
    }

    const pvs = pvsRes.items.map((pv) => {
      const health = longhornByPv.get(pv.metadata?.name ?? "");
      return {
        name: pv.metadata?.name ?? "",
        capacity: pv.spec?.capacity?.storage ?? "",
        storageClass: pv.spec?.storageClassName ?? "",
        accessModes: pv.spec?.accessModes ?? [],
        reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy ?? "",
        status: pv.status?.phase ?? "",
        claimRef: pv.spec?.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : "",
        longhornHealth: health?.robustness ?? null,
        longhornState: health?.state ?? null,
      };
    });

    const pvcs = pvcsRes.items.map((pvc) => {
      const namespace = pvc.metadata?.namespace ?? "";
      const name = pvc.metadata?.name ?? "";
      const health = longhornByPvc.get(pvcKey(namespace, name)) ?? longhornByPv.get(pvc.spec?.volumeName ?? "");
      return {
        namespace,
        name,
        storageClass: pvc.spec?.storageClassName ?? "",
        accessModes: pvc.spec?.accessModes ?? [],
        requestedStorage: pvc.spec?.resources?.requests?.storage ?? "",
        capacity: pvc.status?.capacity?.storage ?? "",
        status: pvc.status?.phase ?? "",
        volumeName: pvc.spec?.volumeName ?? "",
        longhornHealth: health?.robustness ?? null,
        longhornState: health?.state ?? null,
      };
    });

    return NextResponse.json({ pvs, pvcs, live });
  } catch {
    return NextResponse.json({
      live: false,
      pvs: [
        { name: "pv-data-01", capacity: "50Gi", storageClass: "longhorn", accessModes: ["ReadWriteOnce"], reclaimPolicy: "Retain", status: "Bound", claimRef: "default/data-pvc", longhornHealth: "healthy", longhornState: "attached" },
        { name: "pv-monitoring-01", capacity: "30Gi", storageClass: "longhorn", accessModes: ["ReadWriteOnce"], reclaimPolicy: "Delete", status: "Bound", claimRef: "monitoring/prometheus-pvc", longhornHealth: "degraded", longhornState: "attached" },
      ],
      pvcs: [
        { namespace: "default", name: "data-pvc", storageClass: "longhorn", accessModes: ["ReadWriteOnce"], requestedStorage: "50Gi", capacity: "50Gi", status: "Bound", volumeName: "pv-data-01", longhornHealth: "healthy", longhornState: "attached" },
        { namespace: "monitoring", name: "prometheus-pvc", storageClass: "longhorn", accessModes: ["ReadWriteOnce"], requestedStorage: "30Gi", capacity: "30Gi", status: "Bound", volumeName: "pv-monitoring-01", longhornHealth: "degraded", longhornState: "attached" },
      ],
    });
  }
}
