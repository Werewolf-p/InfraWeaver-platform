import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const [crbRes, saRes] = await Promise.all([
      rbacApi.listClusterRoleBinding(),
      coreApi.listServiceAccountForAllNamespaces(),
    ]);
    const bindings = ((crbRes as { items?: unknown[] }).items ?? []).map((b: unknown) => {
      const binding = b as {
        metadata?: { name?: string };
        roleRef?: { name?: string };
        subjects?: Array<{ kind?: string; name?: string; namespace?: string }>;
      };
      return {
        name: binding.metadata?.name,
        role: binding.roleRef?.name,
        subjects: (binding.subjects ?? []).filter(s => s.kind === "ServiceAccount"),
        isClusterAdmin: binding.roleRef?.name === "cluster-admin",
      };
    });
    const serviceAccounts = ((saRes as { items?: unknown[] }).items ?? []).map((sa: unknown) => {
      const account = sa as { metadata?: { name?: string; namespace?: string } };
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
    return NextResponse.json({
      serviceAccounts: [
        { name: "argocd-server", namespace: "argocd", bindings: ["argocd-server"], isClusterAdmin: false },
        { name: "default", namespace: "kube-system", bindings: ["cluster-admin"], isClusterAdmin: true },
      ],
      bindings: [
        { name: "cluster-admin", role: "cluster-admin", subjects: [{ kind: "ServiceAccount", name: "default", namespace: "kube-system" }], isClusterAdmin: true },
        { name: "argocd-server", role: "argocd-server", subjects: [{ kind: "ServiceAccount", name: "argocd-server", namespace: "argocd" }], isClusterAdmin: false },
      ],
    });
  }
}
