import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { listItems } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import * as k8s from "@kubernetes/client-node";

export const GET = withRoute("security:read", async (req) => {
  try {
    const kc = loadKubeConfig(getRequestClusterId(req));
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const [crbRes, saRes] = await Promise.all([
      rbacApi.listClusterRoleBinding(),
      coreApi.listServiceAccountForAllNamespaces(),
    ]);
    const bindings = listItems<{
      metadata?: { name?: string };
      roleRef?: { name?: string };
      subjects?: Array<{ kind?: string; name?: string; namespace?: string }>;
    }>(crbRes).map((binding) => ({
      name: binding.metadata?.name,
      role: binding.roleRef?.name,
      subjects: (binding.subjects ?? []).filter(s => s.kind === "ServiceAccount"),
      isClusterAdmin: binding.roleRef?.name === "cluster-admin",
    }));
    const serviceAccounts = listItems<{ metadata?: { name?: string; namespace?: string } }>(saRes).map((account) => {
      const saBindings = bindings.filter(b => b.subjects.some(s => s.name === account.metadata?.name && s.namespace === account.metadata?.namespace));
      return {
        name: account.metadata?.name,
        namespace: account.metadata?.namespace,
        bindings: saBindings.map(b => b.name),
        isClusterAdmin: saBindings.some(b => b.isClusterAdmin),
      };
    });
    return NextResponse.json({ serviceAccounts, bindings });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
});
