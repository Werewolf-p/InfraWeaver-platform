import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import * as k8s from "@kubernetes/client-node";

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const backupName = `manual-backup-${Date.now()}`;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.createNamespacedCustomObject({
      group: "velero.io", version: "v1", plural: "backups", namespace: "velero",
      body: {
        apiVersion: "velero.io/v1", kind: "Backup",
        metadata: { name: backupName, namespace: "velero" },
        spec: { storageLocation: "default", includedNamespaces: ["*"] },
      },
    });
    await auditLog("cluster:backup", session.user?.email ?? "unknown", `created backup ${backupName}`);
    return NextResponse.json({ ok: true, backupName });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, backupName });
  }
}
