import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";
import yaml from "js-yaml";

const SKIP_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease"];

export async function GET() {
  const session = await auth();
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const [deps, svcs, cms] = await Promise.all([
      appsApi.listDeploymentForAllNamespaces(),
      coreApi.listServiceForAllNamespaces(),
      coreApi.listConfigMapForAllNamespaces(),
    ]);
    const resources = [
      ...(deps.items as unknown[]).filter((i: unknown) => !SKIP_NAMESPACES.includes(((i as { metadata?: { namespace?: string } }).metadata?.namespace ?? ""))),
      ...(svcs.items as unknown[]).filter((i: unknown) => !SKIP_NAMESPACES.includes(((i as { metadata?: { namespace?: string } }).metadata?.namespace ?? ""))),
      ...(cms.items as unknown[]).filter((i: unknown) => !SKIP_NAMESPACES.includes(((i as { metadata?: { namespace?: string } }).metadata?.namespace ?? ""))),
    ];
    const yamlStr = resources.map(r => yaml.dump(r)).join("---\n");
    return new Response(yamlStr, {
      headers: {
        "Content-Type": "application/x-yaml",
        "Content-Disposition": "attachment; filename=cluster-state.yaml",
      },
    });
  } catch {
    const mockYaml = yaml.dump({ kind: "List", apiVersion: "v1", items: [] });
    return new Response(mockYaml, {
      headers: {
        "Content-Type": "application/x-yaml",
        "Content-Disposition": "attachment; filename=cluster-state.yaml",
      },
    });
  }
}
