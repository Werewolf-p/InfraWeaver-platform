// Pure logic for firewall Learn mode: temporarily allow everything for one
// app's pods while recording the FQDNs they resolve, then convert that learned
// list into concrete allowlist rules in one click. No I/O here — unit-tested.
//
// Learning source: hubble_dns_queries_total with `query` + source_namespace/
// source_pod labels (see kubernetes/core/cilium/values.yaml). This learns
// FQDN egress — the overwhelmingly common allow case. Raw-IP flows are not
// learned; they surface as blocked flows again once Learn mode is off.

import type { PromQueryResult } from "./drops";
import type { AllowRule } from "./drops";

export const LEARN_LABEL = "infraweaver.io/learn-mode";

export function learnPolicyName(appLabel: string): string {
  return `${appLabel}-learn-mode`;
}

/**
 * The temp-allow policy: selects the workload and allows all egress + ingress
 * so the app fully works while learning. The kube-dns rule carries a DNS proxy
 * match so Cilium observes every query (and keeps FQDN→IP mappings warm for
 * the toFQDNs rules "Allow learned" writes afterwards).
 */
export function buildLearnPolicy(
  name: string,
  namespace: string,
  selector: Record<string, string>,
  managedBy: string,
): Record<string, unknown> {
  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name,
      namespace,
      labels: { "app.kubernetes.io/managed-by": managedBy, [LEARN_LABEL]: "true" },
    },
    spec: {
      endpointSelector: { matchLabels: selector },
      egress: [
        {
          toEndpoints: [{ matchLabels: { "k8s-app": "kube-dns", "k8s:io.kubernetes.pod.namespace": "kube-system" } }],
          toPorts: [
            {
              ports: [
                { port: "53", protocol: "UDP" },
                { port: "53", protocol: "TCP" },
              ],
              rules: { dns: [{ matchPattern: "*" }] },
            },
          ],
        },
        { toEntities: ["all"] },
      ],
      ingress: [{ fromEntities: ["all"] }],
    },
  };
}

export interface LearnedQuery {
  fqdn: string;
  /** Total queries observed over the learn window, summed across the app's pods. */
  count: number;
}

// Suffixes that are cluster plumbing, not internet egress — never worth a
// toFQDNs rule (in-cluster traffic is policy'd via toEndpoints instead).
const IGNORED_SUFFIXES = [".cluster.local", ".in-addr.arpa", ".ip6.arpa"];

/** PromQL: DNS queries by the app's pods over the learn window. */
export function learnedQueriesQuery(namespace: string, windowMinutes: number): string {
  const w = `${Math.max(1, Math.floor(windowMinutes))}m`;
  return `topk(500, sum by (source_pod, query) (increase(hubble_dns_queries_total{source_namespace="${namespace}"}[${w}])) > 0)`;
}

/**
 * Parse the learned-FQDN list for one app: keep only queries from the app's
 * pods, drop cluster-internal/reverse-lookup noise, strip trailing dots,
 * merge duplicates, sort noisiest-first.
 */
export function parseLearnedQueries(
  result: PromQueryResult | null | undefined,
  podNames: readonly string[],
): LearnedQuery[] {
  const pods = new Set(podNames);
  const byFqdn = new Map<string, number>();
  for (const s of result?.data?.result ?? []) {
    const m = s.metric ?? {};
    if (!pods.has(m.source_pod ?? "")) continue;
    const raw = (m.query ?? "").replace(/\.$/, "").toLowerCase();
    if (!raw || !raw.includes(".")) continue;
    if (IGNORED_SUFFIXES.some((suf) => raw.endsWith(suf))) continue;
    const count = Number(s.value?.[1]);
    if (!Number.isFinite(count) || count <= 0) continue;
    byFqdn.set(raw, (byFqdn.get(raw) ?? 0) + count);
  }
  return [...byFqdn.entries()]
    .map(([fqdn, count]) => ({ fqdn, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One egress rule per learned FQDN (no port restriction — the drop metric has
 * no port label, and learn mode's goal is "make the app work"). Deduped and
 * deterministic so repeat commits stay idempotent against stableStringify.
 */
export function buildLearnedAllowRules(queries: readonly LearnedQuery[]): AllowRule[] {
  const seen = new Set<string>();
  const rules: AllowRule[] = [];
  for (const q of queries) {
    if (seen.has(q.fqdn)) continue;
    seen.add(q.fqdn);
    rules.push({ toFQDNs: [{ matchName: q.fqdn }] });
  }
  return rules;
}
