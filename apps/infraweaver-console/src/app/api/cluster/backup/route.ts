import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { makeCustomApi } from "@/lib/kube-client";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

export const POST = withAuth({ permission: "cluster:admin" }, async ({ session }) => {
  const backupName = `manual-backup-${Date.now()}`;
  try {
    await makeCustomApi().createNamespacedCustomObject({
      group: "velero.io", version: "v1", plural: "backups", namespace: "velero",
      body: {
        apiVersion: "velero.io/v1", kind: "Backup",
        metadata: { name: backupName, namespace: "velero" },
        spec: { storageLocation: "default", includedNamespaces: ["*"] },
      },
    });
    await auditLog("cluster:backup", session.user?.email ?? "unknown", `created backup ${backupName}`);
    return NextResponse.json({ ok: true, backupName });
  } catch (err) {
    return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
  }
});
