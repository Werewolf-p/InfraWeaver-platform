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

type PeerRole = "source" | "destination";

// Classify either end of a flow from Hubble metric labels. Egress denies care
// about the destination; ingress denies care about the source. Behaviour for
// role="destination" is identical to the original classifyDestination.
function classifyPeer(m: Record<string, string>, role: PeerRole): { kind: DestinationKind; target: string; namespace?: string } {
  const fqdn =
    role === "destination"
      ? m.destination_dns || m.destination_fqdn || m.dns_name
      : m.source_dns || m.source_fqdn;
  if (fqdn && fqdn !== "" && fqdn !== "unknown") {
    // Hubble sometimes appends a trailing dot on FQDNs.
    return { kind: "fqdn", target: fqdn.replace(/\.$/, "") };
  }
  const pod = m[`${role}_pod`];
  const ns = m[`${role}_namespace`];
  if (pod && pod !== "" && pod !== "unknown") {
    return { kind: "pod", target: pod, namespace: ns };
  }
  const ip = m[`${role}_ip`] || m[role];
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
function summarizeBy(
  result: PromQueryResult | null | undefined,
  subjectRole: PeerRole,
  peerRole: PeerRole,
): PodBlockedSummary[] {
  const samples = result?.data?.result ?? [];
  const byPod = new Map<string, PodBlockedSummary>();

  for (const s of samples) {
    const m = s.metric ?? {};
    const dropRate = num(s.value?.[1]);
    if (dropRate <= 0) continue;

    const namespace = m[`${subjectRole}_namespace`] || "unknown";
    const pod = m[`${subjectRole}_pod`] || m[subjectRole] || "unknown";
    const podKey = `${namespace}/${pod}`;

    const { kind, target, namespace: peerNs } = classifyPeer(m, peerRole);
    const dest: BlockedDestination = {
      kind,
      target,
      namespace: peerNs,
      // The meaningful port is always the destination (listening) port, for both
      // directions — the subject's own port on ingress, the peer's on egress.
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

    // Dedupe identical peer+port+protocol, summing the rate.
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

// Egress denies grouped by source pod; each "destination" is what the pod tried
// to reach and was blocked from. Behaviour preserved from the original version.
export function summarizeBlockedFlows(result: PromQueryResult | null | undefined): PodBlockedSummary[] {
  return summarizeBy(result, "source", "destination");
}

// Ingress denies grouped by destination pod; each "destination" entry is in fact
// the blocked *source* — who tried to reach this pod and was denied.
export function summarizeBlockedIngress(result: PromQueryResult | null | undefined): PodBlockedSummary[] {
  return summarizeBy(result, "destination", "source");
}

/** Direction of a flow / network-policy rule, from the subject pod's point of view. */
export type FlowDirection = "egress" | "ingress";

// Both queries group on the full source+destination identity so a single result
// carries everything classifyPeer needs for either end.
const FLOW_GROUP_BY =
  "source_namespace, source_pod, source_ip, source_dns, " +
  "destination_namespace, destination_pod, destination_dns, destination_ip, destination_port, protocol, reason";

/** PromQL for recently-dropped EGRESS flows grouped by source pod + destination. */
export function blockedFlowsQuery(windowMinutes = 10): string {
  const w = `${Math.max(1, Math.floor(windowMinutes))}m`;
  return `topk(200, sum by (${FLOW_GROUP_BY}) (rate(hubble_drop_total{direction="EGRESS"}[${w}])) > 0)`;
}

/** PromQL for recently-dropped INGRESS flows grouped by destination pod + source. */
export function blockedIngressQuery(windowMinutes = 10): string {
  const w = `${Math.max(1, Math.floor(windowMinutes))}m`;
  return `topk(200, sum by (${FLOW_GROUP_BY}) (rate(hubble_drop_total{direction="INGRESS"}[${w}])) > 0)`;
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

export interface IngressAllowRule {
  // A single ingress entry to append to the subject pod's CiliumNetworkPolicy.
  fromCIDR?: string[];
  fromEndpoints?: { matchLabels: Record<string, string> }[];
  toPorts?: { ports: { port: string; protocol: string }[] }[];
}

/**
 * Build the ingress allow rule for a denied incoming flow. The peer here is the
 * blocked *source*. Cilium ingress supports fromEndpoints (in-cluster pods) and
 * fromCIDR (external IPs) — there is no fromFQDNs, so FQDN sources are not
 * auto-allowable on ingress.
 */
export function buildIngressAllowRule(peer: BlockedDestination): IngressAllowRule {
  const ports =
    peer.port && peer.protocol
      ? [{ ports: [{ port: peer.port, protocol: peer.protocol.toUpperCase() }] }]
      : undefined;

  switch (peer.kind) {
    case "ip":
      return { fromCIDR: [peer.target], ...(ports ? { toPorts: ports } : {}) };
    case "pod":
      return {
        fromEndpoints: [
          {
            matchLabels: {
              "k8s:io.kubernetes.pod.namespace": peer.namespace || "default",
              "k8s:app": peer.target,
            },
          },
        ],
        ...(ports ? { toPorts: ports } : {}),
      };
    default:
      // fqdn / unknown sources cannot be expressed as an ingress allow.
      return {};
  }
}

export function isIngressAllowable(peer: BlockedDestination): boolean {
  return peer.kind === "ip" || peer.kind === "pod";
}

/** Whether a peer is an in-cluster pod, i.e. a bidirectional allow is meaningful. */
export function isBidirectionalCandidate(peer: BlockedDestination): boolean {
  return peer.kind === "pod" && !!peer.target && peer.target !== "unknown";
}

/** Strip a ReplicaSet/pod hash suffix to recover the app label (mariadb-abc12-x9 -> mariadb). */
export function appLabelFromPod(name: string): string {
  return name.replace(/-[a-z0-9]+(-[a-z0-9]+)?$/, "");
}
