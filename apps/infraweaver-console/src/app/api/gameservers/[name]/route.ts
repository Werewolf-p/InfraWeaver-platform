import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteARecord } from "@/lib/cloudflare";
import { validateK8sName } from "@/lib/api-security";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const cm = await coreApi.readNamespacedConfigMap({ name, namespace: "game-servers" });
    const data = cm.data ?? {};
    const backendType = data["backend-type"] ?? "external";

    let serviceInfo: { assignedIP?: string; serviceStatus: string } = { serviceStatus: "external" };
    if (backendType === "in-cluster") {
      try {
        const svc = await coreApi.readNamespacedService({ name, namespace: "game-servers" });
        serviceInfo = {
          assignedIP: svc.status?.loadBalancer?.ingress?.[0]?.ip,
          serviceStatus: svc.status?.loadBalancer?.ingress?.[0]?.ip ? "active" : "pending",
        };
      } catch {
        serviceInfo = { serviceStatus: "missing" };
      }
    }

    return NextResponse.json({
      name,
      displayName: data["display-name"] ?? name,
      gameType: data["game-type"] ?? "custom",
      targetIP: data["target-ip"] ?? "",
      internalIP: data["internal-ip"] ?? "",
      ports: (() => { try { return JSON.parse(data["ports"] ?? "[]"); } catch { return []; } })(),
      backendType,
      publicDns: data["public-dns"] === "true",
      internalDns: data["internal-dns"] === "true",
      description: data["description"] ?? "",
      createdAt: cm.metadata?.creationTimestamp?.toISOString() ?? null,
      ...serviceInfo,
    });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Read ConfigMap to know what to clean up
    let publicDns = false, internalDns = false, backendType = "external";
    try {
      const cm = await coreApi.readNamespacedConfigMap({ name, namespace: "game-servers" });
      publicDns = cm.data?.["public-dns"] === "true";
      internalDns = cm.data?.["internal-dns"] === "true";
      backendType = cm.data?.["backend-type"] ?? "external";
    } catch {}

    // Delete DNS records
    if (publicDns) { try { await deleteARecord(`${name}.rlservers.com`); } catch {} }
    if (internalDns) { try { await deleteARecord(`${name}.int.rlservers.com`); } catch {} }

    // Delete ConfigMap
    try { await coreApi.deleteNamespacedConfigMap({ name, namespace: "game-servers" }); } catch {}

    // Delete Service if in-cluster
    if (backendType === "in-cluster") {
      try { await coreApi.deleteNamespacedService({ name, namespace: "game-servers" }); } catch {}
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
