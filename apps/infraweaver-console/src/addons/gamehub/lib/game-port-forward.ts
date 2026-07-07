/**
 * Wires a game server's lifecycle to the UDM port-forward connector.
 *
 * On create we open a WAN port-forward named "game-<server>" that maps the
 * server's public port to the node's NodePort. The homelab model (operator's
 * choice) keeps the WAN port EQUAL to the NodePort: `keepFwdPortInSync` makes the
 * connector track `fwd_port` to the assigned WAN port, and because every k8s
 * NodePort is unique cluster-wide, seeding `dst_port` with the NodePort means the
 * rule never collides and never needs bumping — WAN:<nodePort> -> node:<nodePort>.
 *
 * On delete we remove the rule by its deterministic name.
 *
 * Both calls are BEST-EFFORT: a missing or unreachable connector must never block
 * the Kubernetes lifecycle — the pod is still created/deleted, it just isn't
 * WAN-exposed. `getUdmClientAsync()` returns null when the connector is not
 * configured, which we surface as `{ configured: false }` rather than an error.
 */

import type * as k8s from "@kubernetes/client-node";
import { getUdmClientAsync } from "@/lib/udm/config";
import type { PortAllocation, PortForwardProto, PortForwardRule } from "@/lib/udm/types";

/** Deterministic UDM rule name for a game server. Shared by create + delete. */
export function gamePortForwardName(serverName: string): string {
  return `game-${serverName}`;
}

function protoToUdm(protocol: "TCP" | "UDP" | undefined): PortForwardProto {
  return protocol === "UDP" ? "udp" : "tcp";
}

/**
 * Build the WAN->NodePort rule for a game server (pure; unit-testable).
 *
 * WAN and LAN ports are both the NodePort: with `keepFwdPortInSync` the connector
 * forces `fwd_port` to equal the assigned WAN port anyway, so seeding both with
 * the NodePort yields a stable, self-consistent `WAN:<nodePort> -> node:<nodePort>`.
 */
export function buildGamePortForwardRule(input: {
  serverName: string;
  protocol: "TCP" | "UDP";
  nodeIp: string;
  nodePort: number;
}): PortForwardRule {
  const port = String(input.nodePort);
  return {
    name: gamePortForwardName(input.serverName),
    enabled: true,
    proto: protoToUdm(input.protocol),
    dst_port: port,
    fwd: input.nodeIp,
    fwd_port: port,
    src: "any",
    log: false,
  };
}

/**
 * First Ready node's InternalIP — the LAN target a WAN forward must deliver to.
 *
 * Deliberately does NOT consult GAME_HUB_EXTERNAL_HOSTNAME (that is the public
 * side, used for join DNS): a WAN forward's `fwd` has to be a real LAN IPv4 so
 * the UDM can route to the NodePort. Returns null when no Ready node is found.
 */
export async function getLanNodeIp(coreApi: k8s.CoreV1Api): Promise<string | null> {
  const nodes = await coreApi.listNode();
  const ready = nodes.items.find((node) =>
    node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"),
  );
  return ready?.status?.addresses?.find((address) => address.type === "InternalIP")?.address ?? null;
}

export interface GamePortForwardResult {
  /** False when the UDM connector is not configured (no-op, not an error). */
  configured: boolean;
  /** WAN port actually written (equals the NodePort in the normal case). */
  assignedPort?: string;
  requestedPort?: string;
  bumped?: boolean;
  action?: PortAllocation["action"];
  ruleName?: string;
}

/**
 * Open (or reconcile) the WAN port-forward for a game server. Idempotent — keyed
 * by rule name, so re-running for the same server updates in place. Returns
 * `{ configured: false }` when the connector is not set up; otherwise throws only
 * on a live connector error so the caller can decide whether it is fatal.
 */
export async function openGameServerPortForward(input: {
  serverName: string;
  protocol: "TCP" | "UDP";
  nodeIp: string;
  nodePort: number;
}): Promise<GamePortForwardResult> {
  const client = await getUdmClientAsync();
  if (!client) return { configured: false };
  const rule = buildGamePortForwardRule(input);
  const alloc = await client.upsertPortForwardNoConflict(rule, { keepFwdPortInSync: true });
  return {
    configured: true,
    assignedPort: alloc.assignedPort,
    requestedPort: alloc.requestedPort,
    bumped: alloc.bumped,
    action: alloc.action,
    ruleName: rule.name,
  };
}

/**
 * Remove the WAN port-forward for a game server, by rule name. Best-effort:
 * returns false when the connector is not configured. Deleting an absent rule is
 * a no-op inside the client (returns action "absent").
 */
export async function removeGameServerPortForward(serverName: string): Promise<boolean> {
  const client = await getUdmClientAsync();
  if (!client) return false;
  await client.deletePortForward(gamePortForwardName(serverName));
  return true;
}
