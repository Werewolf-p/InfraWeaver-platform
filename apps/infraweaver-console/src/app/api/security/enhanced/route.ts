import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { summarizeArgoAppHealth } from "@/lib/argocd-apps";
import { getRequestClusterId } from "@/lib/cluster-context";
import { listCustomItems, loadKubeConfig } from "@/lib/k8s";
import { listItems } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import { collectKyvernoViolations } from "@/lib/security/kyverno";
import { analyzePodSecurity } from "@/lib/security/pod-analysis";
import type { PodSpec } from "@/lib/security/types";

/** Unwrap one entry of a Promise.allSettled fan-out into its list items ([] on rejection). */
const settled = <T>(result: PromiseSettledResult<unknown>): T[] =>
  result.status === "fulfilled" ? listItems<T>(result.value) : [];

export const GET = withRoute("security:read", async (req) => {
  try {
    const kc = loadKubeConfig(getRequestClusterId(req));
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const policyApi = kc.makeApiClient(k8s.PolicyV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    // Optional integrations report available:false (with empty/zero data)
    // instead of fabricated placeholder values when they cannot be reached.
    const available = {
      externalSecrets: true,
      kyverno: true,
      argocd: true,
      certs: true,
      longhorn: true,
      metallb: true,
      openbao: false,
    };

    const [
      podListRes,
      nsListRes,
      netpolListRes,
      pdbListRes,
      nodeListRes,
      secretListRes,
      cmListRes,
    ] = await Promise.allSettled([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNamespace(),
      networkingApi.listNetworkPolicyForAllNamespaces(),
      policyApi.listPodDisruptionBudgetForAllNamespaces(),
      coreApi.listNode(),
      coreApi.listSecretForAllNamespaces(),
      coreApi.listConfigMapForAllNamespaces(),
    ]);

    const pods = settled<PodSpec>(podListRes);
    const namespaces = settled<{ metadata?: { name?: string } }>(nsListRes).map((ns) => ns.metadata?.name ?? "");
    const netpols = settled<{ metadata?: { namespace?: string } }>(netpolListRes);
    const pdbs = settled<{
      metadata?: { name?: string; namespace?: string };
      spec?: { minAvailable?: number | string; maxUnavailable?: number | string; selector?: unknown };
      status?: { currentHealthy?: number; desiredHealthy?: number; disruptionsAllowed?: number; expectedPods?: number };
    }>(pdbListRes);
    const nodes = settled<{
      metadata?: { name?: string };
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    }>(nodeListRes);
    const secretCount = settled(secretListRes).length;
    const cmCount = settled(cmListRes).length;

    // Pod security analysis
    const {
      counts: { rootPodCount, privilegedCount, hostPathCount, noLimitsCount },
      issues: podSecurityIssues,
    } = analyzePodSecurity(pods);

    // Network policy coverage
    const namespacesWithNetpols = new Set(netpols.map(np => np.metadata?.namespace));
    const unprotectedNamespaces = namespaces.filter(ns =>
      !namespacesWithNetpols.has(ns) &&
      ns !== "kube-system" && ns !== "kube-public" && ns !== "kube-node-lease"
    );

    // PDB list
    const pdbList = pdbs.map(pdb => ({
      name: pdb.metadata?.name ?? "",
      namespace: pdb.metadata?.namespace ?? "",
      minAvailable: pdb.spec?.minAvailable,
      maxUnavailable: pdb.spec?.maxUnavailable,
      currentHealthy: pdb.status?.currentHealthy ?? 0,
      desiredHealthy: pdb.status?.desiredHealthy ?? 0,
      disruptionsAllowed: pdb.status?.disruptionsAllowed ?? 0,
      expectedPods: pdb.status?.expectedPods ?? 0,
    }));

    // Node pressure
    const nodePressure = nodes.map(node => {
      const conditions = node.status?.conditions ?? [];
      return {
        name: node.metadata?.name ?? "",
        memoryPressure: conditions.find(c => c.type === "MemoryPressure")?.status === "True",
        cpuPressure: conditions.find(c => c.type === "CPUPressure")?.status === "True",
        pidPressure: conditions.find(c => c.type === "PIDPressure")?.status === "True",
        diskPressure: conditions.find(c => c.type === "DiskPressure")?.status === "True",
        ready: conditions.find(c => c.type === "Ready")?.status === "True",
      };
    });

    // External Secrets
    let externalSecrets: Array<{
      name: string; namespace: string; ready: boolean; lastSyncTime: string | null; targetSecret: string;
    }> = [];
    try {
      const esItems = await listCustomItems<{
        metadata?: { name?: string; namespace?: string };
        spec?: { target?: { name?: string } };
        status?: { conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string }> };
      }>(customApi, { group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets" });
      externalSecrets = esItems.map((es) => {
        const readyCond = (es.status?.conditions ?? []).find(c => c.type === "Ready");
        return {
          name: es.metadata?.name ?? "",
          namespace: es.metadata?.namespace ?? "",
          ready: readyCond?.status === "True",
          lastSyncTime: readyCond?.lastTransitionTime ?? null,
          targetSecret: es.spec?.target?.name ?? es.metadata?.name ?? "",
        };
      });
    } catch {
      available.externalSecrets = false;
    }

    // Kyverno Policy Reports (missing CRDs contribute no violations)
    const kyvernoViolations = (await collectKyvernoViolations(customApi, { plural: "policyreports" })).map((v) => ({
      name: v.rule ?? v.policy,
      namespace: v.namespace,
      severity: v.severity,
      category: v.category,
      policy: v.policy,
      resource: v.resource,
      message: v.message,
    }));

    // ArgoCD sync status
    let argocdOutOfSync = 0;
    try {
      const argoApps = await listCustomItems<{ status?: { sync?: { status?: string } } }>(customApi, {
        group: "argoproj.io", version: "v1alpha1", plural: "applications",
      });
      argocdOutOfSync = summarizeArgoAppHealth(argoApps).outOfSync;
    } catch {
      available.argocd = false;
    }

    // Cert-manager certificates
    let certCount = 0;
    let certRenewalPending = 0;
    try {
      const certs = await listCustomItems<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }>(customApi, {
        group: "cert-manager.io", version: "v1", plural: "certificates",
      });
      certCount = certs.length;
      certRenewalPending = certs.filter((cert) => {
        const ready = (cert.status?.conditions ?? []).find(cond => cond.type === "Ready");
        return ready?.status !== "True";
      }).length;
    } catch {
      available.certs = false;
    }

    // Longhorn volumes
    let longhornHealthy = 0;
    let longhornDegraded = 0;
    let longhornFaulted = 0;
    try {
      const vols = await listCustomItems<{ status?: { robustness?: string } }>(customApi, {
        group: "longhorn.io", version: "v1beta2", plural: "volumes", namespace: "longhorn-system",
      });
      for (const vol of vols) {
        const r = vol.status?.robustness;
        if (r === "healthy") longhornHealthy++;
        else if (r === "degraded") longhornDegraded++;
        else longhornFaulted++;
      }
    } catch {
      available.longhorn = false;
    }

    // MetalLB IP pool utilization
    let metallbPoolUsed = 0;
    let metallbPoolTotal = 0;
    try {
      const pools = await listCustomItems<{ spec?: { addresses?: string[] } }>(customApi, {
        group: "metallb.io", version: "v1beta1", plural: "ipaddresspools",
      });
      for (const pool of pools) {
        for (const addr of pool.spec?.addresses ?? []) {
          const parts = addr.split("-");
          if (parts.length === 2) {
            const start = parts[0].split(".").map(Number);
            const end = parts[1].split(".").map(Number);
            metallbPoolTotal += (end[3] - start[3] + 1);
          } else {
            metallbPoolTotal += 1;
          }
        }
      }
      // Count services with LoadBalancer IPs
      const svcRes = await coreApi.listServiceForAllNamespaces();
      metallbPoolUsed = listItems<{ spec?: { type?: string }; status?: { loadBalancer?: { ingress?: unknown[] } } }>(svcRes)
        .filter((svc) => svc.spec?.type === "LoadBalancer" && (svc.status?.loadBalancer?.ingress?.length ?? 0) > 0)
        .length;
    } catch {
      available.metallb = false;
    }

    // OpenBao seal status (try HTTP API)
    let openbaoStatus = { initialized: false, sealed: false, standby: false, version: "unknown", keyShares: 0, keyThreshold: 0 };
    try {
      const baoUrl = process.env.OPENBAO_ADDR ?? "http://openbao.openbao.svc.cluster.local:8200";
      const baoRes = await fetch(`${baoUrl}/v1/sys/health`, { signal: AbortSignal.timeout(3000) });
      if (baoRes.ok || baoRes.status === 429 || baoRes.status === 473 || baoRes.status === 501 || baoRes.status === 503) {
        const baoData = await baoRes.json() as {
          initialized?: boolean; sealed?: boolean; standby?: boolean; version?: string;
        };
        openbaoStatus = {
          initialized: baoData.initialized ?? true,
          sealed: baoData.sealed ?? false,
          standby: baoData.standby ?? false,
          version: baoData.version ?? "unknown",
          keyShares: 5,
          keyThreshold: 3,
        };
        available.openbao = true;
      }
    } catch { /* leave unavailable zeros */ }

    // Image list from running pods
    const runningImages = Array.from(
      new Set(
        pods
          .filter(p => p.status?.phase === "Running")
          .flatMap(p => (p.spec?.containers ?? []).map(c => c.image ?? ""))
          .filter(Boolean)
      )
    ).slice(0, 20).map(image => ({ image, vulnerable: false, cveCount: 0, severity: "unknown" as const }));

    return NextResponse.json({
      overview: {
        rootPodCount,
        privilegedCount,
        hostPathCount,
        noLimitsCount,
        secretCount,
        cmCount,
        argocdOutOfSync,
        certCount,
        certRenewalPending,
        longhornHealthy,
        longhornDegraded,
        longhornFaulted,
        metallbPoolUsed,
        metallbPoolTotal,
        nodePressureCount: nodePressure.filter(n =>
          n.memoryPressure || n.cpuPressure || n.pidPressure || n.diskPressure
        ).length,
        nodeCount: nodes.length,
      },
      podSecurityIssues,
      unprotectedNamespaces,
      pdbList,
      nodePressure,
      externalSecrets,
      kyvernoViolations,
      openbaoStatus,
      runningImages,
      available,
    });
  } catch (err) {
    console.error("Enhanced security API error:", err);
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
});
