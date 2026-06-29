// Shared types + pure helpers for the Pod Security firewall surface. These mirror
// the shapes returned by /api/network/blocked-flows and /api/network/pod-rules.
// Kept framework-free so they can be unit-tested without React.

export type Direction = "ingress" | "egress";

export interface BlockedDestination {
  kind: "fqdn" | "ip" | "pod" | "unknown";
  target: string;
  namespace?: string;
  port?: string;
  protocol?: string;
  reason?: string;
  dropRate: number;
}

export interface PodDenies {
  namespace: string;
  pod: string;
  egress: BlockedDestination[];
  ingress: BlockedDestination[];
  totalDropRate: number;
}

export interface DeniesResponse {
  available: boolean;
  dataplaneLive?: boolean;
  windowMinutes?: number;
  pods: PodDenies[];
  reason?: string;
  note?: string;
}

export interface AllowedRuleEntry {
  policyName: string;
  namespace: string;
  direction: Direction;
  index: number;
  peer: string;
  ports: string;
  managed: boolean;
}

export interface RulesResponse {
  available: boolean;
  ingress: AllowedRuleEntry[];
  egress: AllowedRuleEntry[];
}

/** A denial first observed on a poll — the live monitor feed entry. */
export interface FeedEntry {
  id: string;
  ts: number;
  namespace: string;
  pod: string;
  direction: Direction;
  kind: BlockedDestination["kind"];
  target: string;
  port?: string;
}

export const KIND_LABEL: Record<BlockedDestination["kind"], string> = {
  fqdn: "Domain",
  ip: "IP",
  pod: "Pod",
  unknown: "Unknown",
};

export function podKey(p: { namespace: string; pod: string }): string {
  return `${p.namespace}/${p.pod}`;
}

/** Stable identity for a single blocked flow, used for optimistic state + the feed. */
export function flowId(p: { namespace: string; pod: string }, direction: Direction, peer: BlockedDestination): string {
  return `${podKey(p)}|${direction}|${peer.target}|${peer.port ?? ""}`;
}

/**
 * Whether a denied flow can be turned into an allow rule, matching the server's
 * isAllowable / isIngressAllowable. Egress accepts fqdn/ip/pod; ingress has no
 * fromFQDNs, so only ip/pod sources can be expressed.
 */
export function isFlowAllowable(direction: Direction, peer: BlockedDestination): boolean {
  if (peer.kind === "unknown") return false;
  return direction === "egress" ? true : peer.kind === "ip" || peer.kind === "pod";
}

/** Human reason a flow is not auto-allowable, for the disabled control's tooltip. */
export function notAllowableReason(direction: Direction, peer: BlockedDestination): string {
  if (direction === "ingress" && peer.kind === "fqdn") return "Domain sources can't be allowed on the way in";
  return "This peer can't be resolved to a rule yet";
}

/** Total blocked flows across both directions of a pod. */
export function podFlowCount(p: PodDenies): number {
  return p.ingress.length + p.egress.length;
}
