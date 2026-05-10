import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteARecord } from "@/lib/cloudflare";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const svc = await coreApi.readNamespacedService({ name, namespace: "game-servers" });
    const meta = svc.metadata ?? {};
    const annotations = meta.annotations ?? {};

    let cmData: Record<string, string> | undefined;
    try {
      const cm = await coreApi.readNamespacedConfigMap({ name: `${name}-meta`, namespace: "game-servers" });
      cmData = cm.data ?? undefined;
    } catch {}

    return NextResponse.json({
      name: meta.name,
      displayName: annotations["infraweaver.io/display-name"] ?? meta.name,
      gameType: annotations["infraweaver.io/game-type"] ?? "custom",
      allocatedIP: svc.spec?.loadBalancerIP ?? annotations["infraweaver.io/allocated-ip"] ?? null,
      assignedIP: svc.status?.loadBalancer?.ingress?.[0]?.ip ?? null,
      ports: (svc.spec?.ports ?? []).map((p: { port: number; protocol?: string; name?: string }) => ({ port: p.port, protocol: p.protocol ?? "TCP", name: p.name ?? "" })),
      backendType: annotations["infraweaver.io/backend-type"] ?? "external",
      description: annotations["infraweaver.io/description"] ?? "",
      publicDns: annotations["infraweaver.io/public-dns"] === "true",
      internalDns: annotations["infraweaver.io/internal-dns"] === "true",
      createdAt: meta.creationTimestamp?.toISOString() ?? null,
      status: svc.status?.loadBalancer?.ingress?.[0]?.ip ? "active" : "pending",
      metadata: cmData ?? {},
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    let publicDns = false, internalDns = false;
    try {
      const svc = await coreApi.readNamespacedService({ name, namespace: "game-servers" });
      publicDns = svc.metadata?.annotations?.["infraweaver.io/public-dns"] === "true";
      internalDns = svc.metadata?.annotations?.["infraweaver.io/internal-dns"] === "true";
    } catch {}

    if (publicDns) { try { await deleteARecord(`${name}.rlservers.com`); } catch {} }
    if (internalDns) { try { await deleteARecord(`${name}.int.rlservers.com`); } catch {} }

    try { await coreApi.deleteNamespacedService({ name, namespace: "game-servers" }); } catch {}
    try { await coreApi.deleteNamespacedEndpoints({ name, namespace: "game-servers" }); } catch {}
    try { await coreApi.deleteNamespacedConfigMap({ name: `${name}-meta`, namespace: "game-servers" }); } catch {}

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
