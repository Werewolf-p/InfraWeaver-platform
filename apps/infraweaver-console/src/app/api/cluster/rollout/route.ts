import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";

export async function POST() {
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const patch = [{ op: "add", path: "/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt", value: new Date().toISOString() }];
    await appsApi.patchNamespacedDeployment({
      name: "infraweaver-console",
      namespace: "infraweaver-console",
      body: patch,
    }, "application/json-patch+json");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
