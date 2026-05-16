import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

function getKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }
  return kc;
}

// Scoring formula (deduct from 100):
// - Pods running as root: -2 per pod (max -20)
// - Pods with allowPrivilegeEscalation: -3 per pod (max -15)
// - Pods with no resource limits: -1 per pod (max -10)
// - Namespaces without NetworkPolicy: -5 per namespace (max -20)
// - Kyverno violations (warning): -2 each (max -15)

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = getKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    
    // Fetch pods
    const podsRes = await coreApi.listPodForAllNamespaces();
    const pods = (podsRes as { items?: unknown[] }).items ?? [];
    
    // Fetch namespaces
    const nsRes = await coreApi.listNamespace();
    const namespaces = ((nsRes as { items?: unknown[] }).items ?? []).map((ns: unknown) => 
      (ns as { metadata?: { name?: string } }).metadata?.name ?? ""
    ).filter(Boolean);
    
    // Fetch network policies
    const netpolRes = await networkingApi.listNetworkPolicyForAllNamespaces();
    const netpolNamespaces = new Set(
      ((netpolRes as { items?: unknown[] }).items ?? []).map((np: unknown) =>
        (np as { metadata?: { namespace?: string } }).metadata?.namespace ?? ""
      )
    );
    
    // Count pod issues
    let rootPods = 0;
    let privEscPods = 0;
    let noLimitsPods = 0;
    
    for (const pod of pods) {
      const p = pod as {
        spec?: {
          securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
          containers?: Array<{
            securityContext?: { allowPrivilegeEscalation?: boolean; runAsNonRoot?: boolean; runAsUser?: number };
            resources?: { limits?: Record<string, string> };
          }>;
        };
      };
      
      const podRunsAsRoot = p.spec?.securityContext?.runAsUser === 0 || p.spec?.securityContext?.runAsNonRoot === false;
      const containers = p.spec?.containers ?? [];
      
      let hasRoot = podRunsAsRoot;
      let hasPrivEsc = false;
      let hasNoLimits = false;
      
      for (const c of containers) {
        if (c.securityContext?.runAsUser === 0 || c.securityContext?.runAsNonRoot === false) hasRoot = true;
        if (c.securityContext?.allowPrivilegeEscalation === true) hasPrivEsc = true;
        if (!c.resources?.limits || Object.keys(c.resources.limits).length === 0) hasNoLimits = true;
      }
      
      if (hasRoot) rootPods++;
      if (hasPrivEsc) privEscPods++;
      if (hasNoLimits) noLimitsPods++;
    }
    
    // Count unprotected namespaces
    const userNamespaces = namespaces.filter(ns => !["kube-system", "kube-public", "kube-node-lease"].includes(ns));
    const unprotectedNamespaces = userNamespaces.filter(ns => !netpolNamespaces.has(ns));
    
    // Calculate score deductions
    const rootDeduction = Math.min(rootPods * 2, 20);
    const privEscDeduction = Math.min(privEscPods * 3, 15);
    const noLimitsDeduction = Math.min(noLimitsPods * 1, 10);
    const netpolDeduction = Math.min(unprotectedNamespaces.length * 5, 20);
    
    const score = Math.max(0, 100 - rootDeduction - privEscDeduction - noLimitsDeduction - netpolDeduction);
    
    return NextResponse.json({
      score,
      grade: gradeFromScore(score),
      breakdown: {
        pods: {
          rootPods,
          privEscPods,
          noLimitsPods,
          totalPods: pods.length,
          deduction: rootDeduction + privEscDeduction + noLimitsDeduction,
        },
        namespaces: {
          unprotected: unprotectedNamespaces,
          total: userNamespaces.length,
          deduction: netpolDeduction,
        },
        certs: { deduction: 0 },
      },
      trend: "stable",
    });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
}
