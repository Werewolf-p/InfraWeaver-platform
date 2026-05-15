import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { safeError } from "@/lib/utils";
import * as k8s from "@kubernetes/client-node";

function loadKubeConfig() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }
  return kc;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    const [podsData, nodesData, deploymentsData] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNode(),
      appsApi.listDeploymentForAllNamespaces(),
    ]);

    return NextResponse.json({
      healthy: true,
      podCount: podsData.items?.length ?? 0,
      appCount: deploymentsData.items?.length ?? 0,
      nodeCount: nodesData.items?.length ?? 0,
      testedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      healthy: false,
      error: safeError(err),
    });
  }
}
