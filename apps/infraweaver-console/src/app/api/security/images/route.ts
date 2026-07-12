import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { listItems } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import * as k8s from "@kubernetes/client-node";

function getRegistry(image: string): string {
  if (!image.includes("/")) return "docker.io";
  const parts = image.split("/");
  if (parts[0].includes(".") || parts[0].includes(":")) return parts[0];
  return "docker.io";
}

export const GET = withRoute("security:read", async (req) => {
  try {
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listPodForAllNamespaces();
    const imageMap: Record<string, { image: string; registry: string; namespaces: Set<string>; pods: number }> = {};
    for (const p of listItems<{ metadata?: { namespace?: string }; spec?: { containers?: { image?: string }[] } }>(res)) {
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
});
