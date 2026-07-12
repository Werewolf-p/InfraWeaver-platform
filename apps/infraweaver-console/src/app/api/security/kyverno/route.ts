import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { withRoute } from "@/lib/route-utils";
import { collectKyvernoViolations } from "@/lib/security/kyverno";

export const GET = withRoute("security:read", async (req) => {
  try {
    const kc = loadKubeConfig(getRequestClusterId(req));
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const violations = await collectKyvernoViolations(customApi);
    return NextResponse.json({ violations });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable", violations: [] }, { status: 503 });
  }
});
