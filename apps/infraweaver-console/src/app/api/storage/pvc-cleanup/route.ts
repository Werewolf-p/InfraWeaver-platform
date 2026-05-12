import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

function makeClient() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) kc.loadFromFile(process.env.KUBECONFIG);
  else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
  return kc.makeApiClient(k8s.CoreV1Api);
}

// GET — list all PVCs that are not Bound (Released, Pending, Lost, or no phase)
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const coreApi = makeClient();
    const res = await coreApi.listPersistentVolumeClaimForAllNamespaces();

    const unused = res.items
      .filter(pvc => {
        const phase = pvc.status?.phase ?? "";
        // Released = PV exists but PVC is gone; Pending = never bound; Lost = PV gone
        // Also include PVCs in Bound state if their PV is released (shouldn't happen but defensive)
        return phase !== "Bound";
      })
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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE — delete selected PVCs
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { pvcs: Array<{ namespace: string; name: string }> };
  if (!Array.isArray(body.pvcs) || body.pvcs.length === 0) {
    return NextResponse.json({ error: "No PVCs specified" }, { status: 400 });
  }

  const coreApi = makeClient();
  const results: Array<{ namespace: string; name: string; success: boolean; error?: string }> = [];

  for (const { namespace, name } of body.pvcs) {
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace });
      console.log(`[AUDIT] pvc-cleanup | user=${session.user?.email ?? "unknown"} | deleted ${namespace}/${name}`);
      results.push({ namespace, name, success: true });
    } catch (err) {
      console.error(`[pvc-cleanup] failed to delete ${namespace}/${name}:`, err);
      results.push({ namespace, name, success: false, error: String(err) });
    }
  }

  const failed = results.filter(r => !r.success);
  return NextResponse.json({
    results,
    deleted: results.filter(r => r.success).length,
    failed: failed.length,
  }, { status: failed.length > 0 && failed.length === results.length ? 500 : 200 });
}
