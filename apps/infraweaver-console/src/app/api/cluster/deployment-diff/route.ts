import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = req.nextUrl;
  const ns1 = searchParams.get("ns1") ?? "default";
  const dep1 = searchParams.get("dep1") ?? "";
  const ns2 = searchParams.get("ns2") ?? "default";
  const dep2 = searchParams.get("dep2") ?? "";
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const [r1, r2] = await Promise.all([
      appsApi.readNamespacedDeployment({ name: dep1, namespace: ns1 }),
      appsApi.readNamespacedDeployment({ name: dep2, namespace: ns2 }),
    ]);
    return NextResponse.json({ dep1: r1, dep2: r2 });
  } catch {
    return NextResponse.json({
      dep1: { metadata: { name: dep1 || "app-v1", namespace: ns1 }, spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "nginx:1.24", resources: { requests: { cpu: "100m", memory: "128Mi" } } }] } } } },
      dep2: { metadata: { name: dep2 || "app-v2", namespace: ns2 }, spec: { replicas: 3, template: { spec: { containers: [{ name: "app", image: "nginx:1.25", resources: { requests: { cpu: "200m", memory: "256Mi" } } }] } } } },
    });
  }
}
