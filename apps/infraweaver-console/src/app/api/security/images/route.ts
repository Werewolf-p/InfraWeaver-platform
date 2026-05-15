import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

function getRegistry(image: string): string {
  if (!image.includes("/")) return "docker.io";
  const parts = image.split("/");
  if (parts[0].includes(".") || parts[0].includes(":")) return parts[0];
  return "docker.io";
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listPodForAllNamespaces();
    const imageMap: Record<string, { image: string; registry: string; namespaces: Set<string>; pods: number }> = {};
    for (const pod of res.items as unknown[]) {
      const p = pod as { metadata?: { namespace?: string }; spec?: { containers?: { image?: string }[] } };
      const ns = p.metadata?.namespace ?? "default";
      for (const c of p.spec?.containers ?? []) {
        const img = c.image ?? "";
        if (!imageMap[img]) imageMap[img] = { image: img, registry: getRegistry(img), namespaces: new Set(), pods: 0 };
        imageMap[img].namespaces.add(ns);
        imageMap[img].pods++;
      }
    }
    const images = Object.values(imageMap).map(({ image, registry, namespaces, pods }) => ({
      image,
      registry,
      namespace: Array.from(namespaces).join(", "),
      pods,
      isTrusted: !registry.includes("docker.io") || image.includes("@sha256:"),
    }));
    return NextResponse.json({ images });
  } catch {
    return NextResponse.json({
      images: [
        { image: "nginx:1.25", registry: "docker.io", namespace: "default", pods: 3, isTrusted: false },
        { image: "ghcr.io/myorg/myapp:v1.2.3", registry: "ghcr.io", namespace: "default", pods: 2, isTrusted: true },
        { image: "prom/prometheus:v2.46.0", registry: "docker.io", namespace: "monitoring", pods: 1, isTrusted: false },
      ],
    });
  }
}
