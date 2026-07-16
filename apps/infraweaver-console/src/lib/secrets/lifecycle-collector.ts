import "server-only";

/**
 * Secret & GitOps lifecycle orchestrator — SERVER ONLY.
 *
 * Fans out every collector with Promise.allSettled (mirrors /api/security/enhanced
 * resilience) so a single failing backend degrades one section rather than the
 * whole report. Correlates ArgoCD Degraded/OutOfSync apps to not-Ready
 * ExternalSecrets in their namespace, then rolls everything up into one severity.
 *
 * The output `SecretLifecycleReport` is Subject 5's public contract: the shared
 * `SecretHealthSummary` component and Subject 2's observability board both read it.
 */

import * as k8s from "@kubernetes/client-node";
import { getArgocdAppsCached, type ArgoApplication } from "@/lib/argocd-apps";
import { loadKubeConfig } from "@/lib/k8s";
import { vaultAuth } from "@/lib/openbao/kv";
import { collectCatalogCoverage } from "@/lib/secrets/catalog-coverage";
import { collectEsLifecycle } from "@/lib/secrets/eso-health";
import { lookupSelfToken } from "@/lib/secrets/openbao-token";
import { getPublicMirrorStatus } from "@/lib/secrets/public-mirror";
import { isRemediationWriteEnabled } from "@/lib/secrets/remediation-guard";
import {
  computeSeverity,
  type ArgoSecretCorrelation,
  type EsLifecycle,
  type OpenBaoSeal,
  type SecretLifecycleReport,
} from "@/lib/secrets/lifecycle-types";

const SEAL_HEALTH_TIMEOUT_MS = 3000;

async function getOpenBaoSeal(): Promise<OpenBaoSeal> {
  const unavailable: OpenBaoSeal = { available: false, initialized: false, sealed: false, standby: false, version: "unknown" };
  let addr: string;
  try {
    ({ addr } = vaultAuth());
  } catch {
    return unavailable;
  }
  try {
    const res = await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(SEAL_HEALTH_TIMEOUT_MS) });
    // 429/473/501/503 are documented health codes that still carry a JSON body.
    if (!(res.ok || [429, 473, 501, 503].includes(res.status))) return unavailable;
    const data = (await res.json()) as { initialized?: boolean; sealed?: boolean; standby?: boolean; version?: string };
    return {
      available: true,
      initialized: data.initialized ?? true,
      sealed: data.sealed ?? false,
      standby: data.standby ?? false,
      version: data.version ?? "unknown",
    };
  } catch {
    return unavailable;
  }
}

/** Join Degraded/OutOfSync Argo apps to not-Ready ES in the same namespace. */
function correlateArgo(apps: ArgoApplication[], externalSecrets: EsLifecycle[]): ArgoSecretCorrelation[] {
  const notReadyByNs = new Map<string, string[]>();
  for (const es of externalSecrets) {
    if (es.ready) continue;
    const list = notReadyByNs.get(es.namespace) ?? [];
    list.push(es.name);
    notReadyByNs.set(es.namespace, list);
  }

  const correlations: ArgoSecretCorrelation[] = [];
  for (const app of apps) {
    const health = app.status?.health?.status ?? "";
    const sync = app.status?.sync?.status ?? "";
    const isProblem = health === "Degraded" || sync === "OutOfSync";
    if (!isProblem) continue;
    const namespace = app.spec?.destination?.namespace ?? "";
    const notReady = notReadyByNs.get(namespace) ?? [];
    if (notReady.length === 0) continue; // only surface Argo problems ES can explain
    correlations.push({ app: app.metadata?.name ?? "", namespace, health, sync, notReadyExternalSecrets: notReady });
  }
  return correlations;
}

export async function collectSecretLifecycle(clusterId?: string): Promise<SecretLifecycleReport> {
  const [tokenRes, sealRes] = await Promise.allSettled([lookupSelfToken(), getOpenBaoSeal()]);
  const token = tokenRes.status === "fulfilled"
    ? tokenRes.value
    : { available: false, ttlSeconds: null, expireTime: null, renewable: false, policies: [], error: "lookup failed" };
  const openbao = sealRes.status === "fulfilled" ? sealRes.value : { available: false, initialized: false, sealed: false, standby: false, version: "unknown" };

  // ES lifecycle needs a live cluster; key-resolution needs a reachable, unsealed OpenBao.
  const resolveKeys = openbao.available && !openbao.sealed;
  let esAvailable = true;
  let externalSecrets: EsLifecycle[] = [];
  try {
    const customApi = loadKubeConfig(clusterId).makeApiClient(k8s.CustomObjectsApi);
    externalSecrets = await collectEsLifecycle(customApi, { resolveKeys });
  } catch {
    esAvailable = false;
  }

  const [coverageRes, mirrorRes, argoRes] = await Promise.allSettled([
    resolveKeys ? collectCatalogCoverage(externalSecrets) : Promise.resolve([]),
    getPublicMirrorStatus(),
    getArgocdAppsCached(clusterId),
  ]);

  const coverageItems = coverageRes.status === "fulfilled" ? coverageRes.value : [];
  const coverageAvailable = coverageRes.status === "fulfilled" && resolveKeys;
  const publicMirror = mirrorRes.status === "fulfilled"
    ? mirrorRes.value
    : { available: false, workflowName: null, status: null, conclusion: null, updatedAt: null, htmlUrl: null, error: "mirror lookup failed" };
  const argoApps = argoRes.status === "fulfilled" ? argoRes.value.apps : [];
  const argoCorrelations = correlateArgo(argoApps, externalSecrets);

  const notReady = externalSecrets.filter((es) => !es.ready).length;
  const retainTraps = externalSecrets.filter((es) => es.isRetainTrap).length;
  const totalMissing = coverageItems.reduce((sum, item) => sum + item.missingKeys.length, 0);

  const severity = computeSeverity({
    token,
    openbaoAvailable: openbao.available,
    sealed: openbao.sealed,
    esNotReady: notReady,
    retainTraps,
    missingCatalogKeys: totalMissing,
    mirrorFailing: publicMirror.available && publicMirror.conclusion === "failure",
  });

  return {
    severity,
    generatedAt: new Date().toISOString(),
    remediationWriteEnabled: isRemediationWriteEnabled(),
    token,
    openbao,
    externalSecrets: { available: esAvailable, items: externalSecrets, total: externalSecrets.length, notReady, retainTraps },
    catalogCoverage: { available: coverageAvailable, items: coverageItems, totalMissing },
    publicMirror,
    argoCorrelations,
  };
}
