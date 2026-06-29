// Pure logic for the "what is currently allowed for this pod -> remove a rule"
// side of the firewall feature. Reads CiliumNetworkPolicy objects and flattens
// their ingress/egress arrays into a flat, addressable list; removes a single
// rule immutably. No I/O, no k8s client, no fetch — unit-tested in isolation.

import type { FlowDirection } from "./drops";

export const MANAGED_BY = "infraweaver-console";

export interface CnpObject {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    endpointSelector?: { matchLabels?: Record<string, string> };
    ingress?: unknown[];
    egress?: unknown[];
  };
}

export interface AllowedRuleEntry {
  policyName: string;
  namespace: string;
  direction: FlowDirection;
  index: number; // index within spec.ingress / spec.egress
  peer: string; // human-readable peer description
  ports: string; // human-readable ports, or "all ports"
  managed: boolean; // created by infraweaver-console
}

type RuleObject = Record<string, unknown>;

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function labelPeer(sel: unknown): string | null {
  const arr = asArray<{ matchLabels?: Record<string, string> }>(sel);
  if (arr.length === 0) return null;
  const parts = arr.map((e) => {
    const labels = e?.matchLabels ?? {};
    const ns = labels["k8s:io.kubernetes.pod.namespace"] || labels["io.kubernetes.pod.namespace"];
    const app = labels["k8s:app"] || labels.app || Object.values(labels)[0] || "?";
    return ns ? `${ns}/${app}` : String(app);
  });
  return `pod: ${parts.join(", ")}`;
}

/** Human-readable description of a rule's peer, for either direction. */
export function describePeer(rule: RuleObject, direction: FlowDirection): string {
  if (!rule || typeof rule !== "object") return "any";
  if (direction === "egress") {
    const fqdns = asArray<{ matchName?: string; matchPattern?: string }>(rule.toFQDNs);
    if (fqdns.length) return `fqdn: ${fqdns.map((f) => f.matchName || f.matchPattern || "?").join(", ")}`;
    const cidr = asArray<string>(rule.toCIDR);
    if (cidr.length) return `cidr: ${cidr.join(", ")}`;
    const ep = labelPeer(rule.toEndpoints);
    if (ep) return ep;
    const ent = asArray<string>(rule.toEntities);
    if (ent.length) return `entity: ${ent.join(", ")}`;
  } else {
    const cidr = asArray<string>(rule.fromCIDR);
    if (cidr.length) return `cidr: ${cidr.join(", ")}`;
    const ep = labelPeer(rule.fromEndpoints);
    if (ep) return ep;
    const ent = asArray<string>(rule.fromEntities);
    if (ent.length) return `entity: ${ent.join(", ")}`;
  }
  return "any";
}

/** Human-readable port list for a rule, or "all ports" when unrestricted. */
export function describePorts(rule: RuleObject): string {
  const toPorts = asArray<{ ports?: { port?: string; protocol?: string }[] }>(rule?.toPorts);
  const ports = toPorts.flatMap((p) => asArray<{ port?: string; protocol?: string }>(p.ports));
  if (ports.length === 0) return "all ports";
  return ports.map((p) => `${p.port ?? "?"}/${(p.protocol ?? "ANY").toUpperCase()}`).join(", ");
}

function flattenDirection(policy: CnpObject, direction: FlowDirection): AllowedRuleEntry[] {
  const rules = asArray<RuleObject>(direction === "ingress" ? policy.spec?.ingress : policy.spec?.egress);
  const managed = policy.metadata?.labels?.["app.kubernetes.io/managed-by"] === MANAGED_BY;
  return rules.map((rule, index) => ({
    policyName: policy.metadata?.name ?? "(unnamed)",
    namespace: policy.metadata?.namespace ?? "default",
    direction,
    index,
    peer: describePeer(rule, direction),
    ports: describePorts(rule),
    managed,
  }));
}

/** Flatten a set of CiliumNetworkPolicies into a flat list of allowed rules. */
export function flattenPolicyRules(policies: CnpObject[]): AllowedRuleEntry[] {
  const out: AllowedRuleEntry[] = [];
  for (const policy of policies ?? []) {
    out.push(...flattenDirection(policy, "ingress"));
    out.push(...flattenDirection(policy, "egress"));
  }
  return out;
}

/** True when the policy's endpointSelector targets the given app label. */
export function policySelectsApp(policy: CnpObject, app: string): boolean {
  const labels = policy.spec?.endpointSelector?.matchLabels ?? {};
  return labels.app === app || labels["k8s:app"] === app;
}

export interface RemoveResult {
  spec: NonNullable<CnpObject["spec"]>;
  empty: boolean; // true when no ingress and no egress rules remain
}

/**
 * Remove the rule at `index` in the given direction, returning a NEW spec.
 * Returns null when the index is out of range. `empty` signals the caller that
 * the policy now has no rules left and should be deleted rather than patched.
 */
export function removeRuleFromSpec(
  policy: CnpObject,
  direction: FlowDirection,
  index: number,
): RemoveResult | null {
  const current = asArray<RuleObject>(direction === "ingress" ? policy.spec?.ingress : policy.spec?.egress);
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;

  const next = current.filter((_, i) => i !== index);
  const spec: NonNullable<CnpObject["spec"]> = { ...(policy.spec ?? {}), [direction]: next };

  const ingressLen = asArray(direction === "ingress" ? next : policy.spec?.ingress).length;
  const egressLen = asArray(direction === "egress" ? next : policy.spec?.egress).length;
  return { spec, empty: ingressLen === 0 && egressLen === 0 };
}
