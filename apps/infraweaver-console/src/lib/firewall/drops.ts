// Pure logic for the "recently blocked -> allow next time" firewall feature.
// Data source: Cilium Hubble `hubble_drop_total` series scraped by Prometheus.
// Everything here is pure and unit-tested; no I/O, no k8s, no fetch.
//
// Expected Hubble drop-metric context (see kubernetes/core/cilium/values.yaml):
//   drop:sourceContext=namespace|pod;destinationContext=namespace|pod|dns
// which yields Prometheus labels: source_namespace, source_pod,
// destination_namespace, destination_pod, destination_dns (FQDN, when known),
// plus reason / protocol.

export interface PromSample {
  metric: Record<string, string>;
  value: [number, string]; // [unixSeconds, sampleValueAsString]
}

export interface PromQueryResult {
  status: string;
  data?: { resultType: string; result: PromSample[] };
}

export type DestinationKind = "fqdn" | "ip" | "pod" | "unknown";

export interface BlockedDestination {
  kind: DestinationKind;
  // The value to allow: an FQDN, a CIDR, or namespace/pod.
  target: string;
  namespace?: string; // for pod targets
  port?: string;
  protocol?: string;
  reason?: string;
  // Aggregated drop rate (per second) over the query window.
  dropRate: number;
}

export interface PodBlockedSummary {
  namespace: string;
  pod: string;
  destinations: BlockedDestination[];
  totalDropRate: number;
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function classifyDestination(m: Record<string, string>): { kind: DestinationKind; target: string; namespace?: string } {
  const fqdn = m.destination_dns || m.destination_fqdn || m.dns_name;
  if (fqdn && fqdn !== "" && fqdn !== "unknown") {
    // Hubble sometimes appends a trailing dot on FQDNs.
    return { kind: "fqdn", target: fqdn.replace(/\.$/, "") };
  }
  const pod = m.destination_pod;
  const ns = m.destination_namespace;
  if (pod && pod !== "" && pod !== "unknown") {
    return { kind: "pod", target: pod, namespace: ns };
  }
  const ip = m.destination_ip || m.destination;
  if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return { kind: "ip", target: `${ip}/32` };
  }
  return { kind: "unknown", target: ip || pod || ns || "unknown", namespace: ns };
}

/**
 * Parse a Prometheus instant-query result for hubble_drop_total into a per-pod
 * summary of recently blocked destinations, sorted by drop rate (noisiest first).
 * Tolerant of missing labels so it never throws on partial data.
 */
export function summarizeBlockedFlows(result: PromQueryResult | null | undefined): PodBlockedSummary[] {
  const samples = result?.data?.result ?? [];
  const byPod = new Map<string, PodBlockedSummary>();

  for (const s of samples) {
    const m = s.metric ?? {};
    const dropRate = num(s.value?.[1]);
    if (dropRate <= 0) continue;

    const namespace = m.source_namespace || "unknown";
    const pod = m.source_pod || m.source || "unknown";
    const podKey = `${namespace}/${pod}`;

    const { kind, target, namespace: destNs } = classifyDestination(m);
    const dest: BlockedDestination = {
      kind,
      target,
      namespace: destNs,
      port: m.destination_port || m.port || undefined,
      protocol: m.protocol || undefined,
      reason: m.reason || undefined,
      dropRate,
    };

    let summary = byPod.get(podKey);
    if (!summary) {
      summary = { namespace, pod, destinations: [], totalDropRate: 0 };
      byPod.set(podKey, summary);
    }

    // Dedupe identical destination+port+protocol, summing the rate.
    const existing = summary.destinations.find(
      (d) => d.target === dest.target && d.port === dest.port && d.protocol === dest.protocol,
    );
    if (existing) {
      existing.dropRate += dropRate;
    } else {
      summary.destinations.push(dest);
    }
    summary.totalDropRate += dropRate;
  }

  const out = [...byPod.values()];
  for (const s of out) s.destinations.sort((a, b) => b.dropRate - a.dropRate);
  out.sort((a, b) => b.totalDropRate - a.totalDropRate);
  return out;
}

/** PromQL for recently-dropped EGRESS flows grouped by source pod + destination. */
export function blockedFlowsQuery(windowMinutes = 10): string {
  const w = `${Math.max(1, Math.floor(windowMinutes))}m`;
  return (
    `topk(200, sum by ` +
    `(source_namespace, source_pod, destination_namespace, destination_pod, destination_dns, destination_ip, destination_port, protocol, reason) ` +
    `(rate(hubble_drop_total{direction="EGRESS"}[${w}])) > 0)`
  );
}

export interface AllowRule {
  // A single egress entry to append to the pod's CiliumNetworkPolicy.
  toFQDNs?: { matchName: string }[];
  toCIDR?: string[];
  toEndpoints?: { matchLabels: Record<string, string> }[];
  toPorts?: { ports: { port: string; protocol: string }[] }[];
}

/**
 * Build the egress allow rule an admin's "Allow next time" click should append to
 * the source pod's policy. FQDN destinations become toFQDNs (Cilium FQDN policy);
 * IPs become toCIDR; in-cluster pods become toEndpoints.
 */
export function buildAllowRule(dest: BlockedDestination): AllowRule {
  const ports =
    dest.port && dest.protocol
      ? [{ ports: [{ port: dest.port, protocol: dest.protocol.toUpperCase() }] }]
      : undefined;

  switch (dest.kind) {
    case "fqdn":
      return { toFQDNs: [{ matchName: dest.target }], ...(ports ? { toPorts: ports } : {}) };
    case "ip":
      return { toCIDR: [dest.target], ...(ports ? { toPorts: ports } : {}) };
    case "pod":
      return {
        toEndpoints: [
          {
            matchLabels: {
              "k8s:io.kubernetes.pod.namespace": dest.namespace || "default",
              "k8s:app": dest.target,
            },
          },
        ],
        ...(ports ? { toPorts: ports } : {}),
      };
    default:
      // Unknown destinations are not auto-allowable; caller should reject.
      return {};
  }
}

export function isAllowable(dest: BlockedDestination): boolean {
  return dest.kind === "fqdn" || dest.kind === "ip" || dest.kind === "pod";
}
