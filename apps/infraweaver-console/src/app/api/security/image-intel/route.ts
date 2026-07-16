import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { listItems, makeCoreApi } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import { assessSupplyChain, type RunningImage } from "@/lib/images/supply-chain";
import { fetchVulnerabilityReports } from "@/lib/images/trivy-reports";
import { assessScanCoverage, buildImageMatrix, rollupImageVulns } from "@/lib/images/vuln-rollup";

function registryOf(image: string): string {
  if (!image.includes("/")) return "docker.io";
  const first = image.split("/")[0];
  if (first.includes(".") || first.includes(":")) return first;
  return "docker.io";
}

/**
 * Image supply-chain + CVE intelligence. Supply-chain (pin status) always works
 * from running pods; CVE data comes from Trivy VulnerabilityReport CRDs and
 * degrades to available:false when the operator is absent (never fabricated).
 */
export const GET = withRoute("security:read", async (req) => {
  const coreApi = makeCoreApi(getRequestClusterId(req));
  const podsResp = await coreApi.listPodForAllNamespaces();

  const imageMap = new Map<string, { registry: string; namespaces: Set<string>; pods: number }>();
  for (const pod of listItems<{ metadata?: { namespace?: string }; spec?: { containers?: { image?: string }[] } }>(podsResp)) {
    const namespace = pod.metadata?.namespace ?? "default";
    for (const container of pod.spec?.containers ?? []) {
      const image = container.image ?? "";
      if (!image) continue;
      const entry = imageMap.get(image) ?? { registry: registryOf(image), namespaces: new Set<string>(), pods: 0 };
      entry.namespaces.add(namespace);
      entry.pods += 1;
      imageMap.set(image, entry);
    }
  }

  const running: RunningImage[] = [...imageMap.entries()].map(([image, v]) => ({
    image,
    registry: v.registry,
    pods: v.pods,
    namespaces: [...v.namespaces],
  }));

  const supplyChain = assessSupplyChain(running);
  const { reports, available } = await fetchVulnerabilityReports();
  const matrix = buildImageMatrix(running, reports);
  const rollup = rollupImageVulns(matrix);
  const coverage = assessScanCoverage(matrix, Date.now());

  return NextResponse.json({ supplyChain, cve: { available, matrix, rollup, coverage } });
});
