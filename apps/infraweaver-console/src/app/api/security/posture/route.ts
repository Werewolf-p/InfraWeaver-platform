import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { listItems } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import * as k8s from "@kubernetes/client-node";

// Vendor-managed system / infrastructure namespaces. Their pods run privileged
// components BY DESIGN — the CNI (Cilium), CSI drivers (Longhorn, local-path),
// the load balancer (MetalLB), log/metric agents (promtail, node-exporter),
// backup (Velero) and the kube control plane legitimately run as root, allow
// privilege escalation, or ship without resource limits, and most are managed by
// upstream Helm charts the operator does not hand-tune. Scoring them produces
// permanent, unactionable noise. So — exactly as the NetworkPolicy check already
// skipped kube-system/kube-public/kube-node-lease — EVERY posture check now scopes
// to operator-configured WORKLOAD namespaces by excluding this one shared set.
const SYSTEM_NAMESPACES = new Set<string>([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "cilium-secrets",
  "longhorn-system",
  "local-path-storage",
  "metallb-system",
  "velero",
  "monitoring",
  "crds",
  "bootstrap",
  "default", // ships empty; carries no operator workloads
]);

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";

// Scoring formula (deduct from 100):
// - Pods running as root: -2 per pod (max -20)
// - Pods with allowPrivilegeEscalation: -3 per pod (max -15)
// - Pods with no resource limits: -1 per pod (max -10)
// - Workload namespaces with no network policy: -5 per namespace (max -20)
//   "no network policy" = neither a k8s NetworkPolicy NOR a CiliumNetworkPolicy.
//   Cilium is THIS cluster's enforcer, so counting only k8s NetworkPolicy reported
//   every airgapped-via-CNP namespace as unprotected and sank the grade with a
//   false negative. All pod/namespace checks skip SYSTEM_NAMESPACES (see above).

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// NOTE: intentionally NOT lib/security/pod-analysis.analyzePodSecurity — the
// posture score counts per POD (not per container), includes non-Running pods,
// and only flags explicit allowPrivilegeEscalation:true, so swapping analyzers
// would change the score.
export const GET = withRoute("security:read", async (req) => {
  try {
    const kc = loadKubeConfig(getRequestClusterId(req));
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    // Fetch pods
    const podsRes = await coreApi.listPodForAllNamespaces();
    const pods = listItems<{
      metadata?: { namespace?: string };
      spec?: {
        securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
        containers?: Array<{
          securityContext?: { allowPrivilegeEscalation?: boolean; runAsNonRoot?: boolean; runAsUser?: number };
          resources?: { limits?: Record<string, string> };
        }>;
      };
    }>(podsRes);

    // Fetch namespaces
    const nsRes = await coreApi.listNamespace();
    const namespaces = listItems<{ metadata?: { name?: string } }>(nsRes)
      .map((ns) => ns.metadata?.name ?? "")
      .filter(Boolean);

    // Fetch network policies — a namespace counts as protected if it has EITHER a
    // standard k8s NetworkPolicy OR a CiliumNetworkPolicy (Cilium is the enforcer).
    const netpolRes = await networkingApi.listNetworkPolicyForAllNamespaces();
    const protectedNamespaces = new Set(
      listItems<{ metadata?: { namespace?: string } }>(netpolRes).map((np) => np.metadata?.namespace ?? "")
    );
    try {
      const cnpRes = await customApi.listClusterCustomObject({
        group: CNP_GROUP,
        version: CNP_VERSION,
        plural: CNP_PLURAL,
      });
      for (const cnp of listItems<{ metadata?: { namespace?: string } }>(cnpRes)) {
        if (cnp.metadata?.namespace) protectedNamespaces.add(cnp.metadata.namespace);
      }
    } catch {
      // Cilium CRD not installed on this cluster — fall back to k8s NetworkPolicy
      // coverage only rather than failing the whole posture score.
    }

    // Count pod issues — skip vendor-managed system/infra namespaces.
    let rootPods = 0;
    let privEscPods = 0;
    let noLimitsPods = 0;

    for (const p of pods) {
      if (SYSTEM_NAMESPACES.has(p.metadata?.namespace ?? "")) continue;

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

    // Count unprotected workload namespaces (system/infra namespaces excluded).
    const userNamespaces = namespaces.filter((ns) => !SYSTEM_NAMESPACES.has(ns));
    const unprotectedNamespaces = userNamespaces.filter((ns) => !protectedNamespaces.has(ns));

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
});
