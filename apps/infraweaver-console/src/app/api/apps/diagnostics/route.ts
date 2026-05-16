import * as k8s from "@kubernetes/client-node";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import {
  ACTIVE_CLUSTER_COOKIE,
  getActiveClusterIdFromCookieValue,
  getClusterConfig,
  getDefaultClusterId,
} from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

const DEFAULT_ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const DEFAULT_ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const clusterId = getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value);
    const clusterConfig = getClusterConfig(clusterId) ?? getClusterConfig(getDefaultClusterId());
    const argocdServer = clusterConfig?.argocdServer ?? DEFAULT_ARGOCD_SERVER;
    const argocdToken = clusterConfig?.argocdToken ?? DEFAULT_ARGOCD_TOKEN;

    let argocdApiReachable = false;
    try {
      const response = await fetch(`${argocdServer}/api/v1/applications?limit=1`, {
        headers: {
          ...(argocdToken ? { Authorization: `Bearer ${argocdToken}` } : {}),
          "Content-Type": "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      argocdApiReachable = response.ok;
    } catch {
      argocdApiReachable = false;
    }

    let argocdCrdExists = false;
    try {
      const apiExtApi = loadKubeConfig(clusterId).makeApiClient(k8s.ApiextensionsV1Api);
      await apiExtApi.readCustomResourceDefinition({ name: "applications.argoproj.io" });
      argocdCrdExists = true;
    } catch {
      argocdCrdExists = false;
    }

    const { dataSource } = await getArgocdAppsCached(clusterId);

    return NextResponse.json({
      argocdApiReachable,
      argocdTokenSet: Boolean(argocdToken.trim()),
      argocdCrdExists,
      githubTokenSet: Boolean(process.env.GITHUB_TOKEN?.trim()),
      dataSource,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
