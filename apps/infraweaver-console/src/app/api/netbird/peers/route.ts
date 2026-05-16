import { NextResponse } from "next/server";
import { requireRoutePermissions } from "@/lib/route-utils";

const NETBIRD_API = process.env.NETBIRD_API ?? "http://netbird-management.netbird.svc.cluster.local:80";
const NETBIRD_MANAGEMENT_TOKEN = process.env.NETBIRD_MANAGEMENT_TOKEN ?? process.env.NETBIRD_TOKEN ?? "";

interface NetBirdPeer {
  id: string;
  name: string;
  ip: string | null;
  connected: boolean;
  lastSeen: string | null;
  groups: string[];
  os: string | null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function toPeer(entry: unknown): NetBirdPeer {
  const peer = entry as {
    id?: string;
    name?: string;
    hostname?: string;
    dns_label?: string;
    ip?: string;
    ip_address?: string;
    ip_addresses?: string[];
    connected?: boolean;
    last_seen?: string;
    os?: string;
    groups?: Array<{ name?: string }>;
  };

  const firstIp = Array.isArray(peer.ip_addresses) ? stringValue(peer.ip_addresses[0]) : null;

  return {
    id: stringValue(peer.id) ?? crypto.randomUUID(),
    name: stringValue(peer.name) ?? stringValue(peer.hostname) ?? stringValue(peer.dns_label) ?? "Unnamed peer",
    ip: stringValue(peer.ip) ?? stringValue(peer.ip_address) ?? firstIp,
    connected: booleanValue(peer.connected),
    lastSeen: stringValue(peer.last_seen),
    groups: (peer.groups ?? []).map((group) => group.name).filter((group): group is string => Boolean(group)),
    os: stringValue(peer.os),
  };
}

function mockPeers(): NetBirdPeer[] {
  return [
    { id: "peer-1", name: "talos-prod-cp1", ip: "100.64.0.11", connected: true, lastSeen: new Date().toISOString(), groups: ["k8s", "control-plane"], os: "Talos Linux" },
    { id: "peer-2", name: "talos-prod-cp2", ip: "100.64.0.12", connected: true, lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(), groups: ["k8s", "control-plane"], os: "Talos Linux" },
    { id: "peer-3", name: "workstation", ip: "100.64.0.42", connected: false, lastSeen: new Date(Date.now() - 3_600_000).toISOString(), groups: ["admin"], os: "macOS" },
  ];
}

export async function GET() {
  const session = await requireRoutePermissions({ any: ["infra:read", "cluster:admin"] });
  if (session instanceof NextResponse) return session;

  if (!NETBIRD_MANAGEMENT_TOKEN) {
    return NextResponse.json(mockPeers());
  }

  try {
    const response = await fetch(`${NETBIRD_API}/api/peers`, {
      headers: {
        Authorization: `Bearer ${NETBIRD_MANAGEMENT_TOKEN}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("NetBird API request failed");
    }

    const payload = await response.json() as unknown;
    const peers = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { peers?: unknown[] }).peers)
        ? (payload as { peers: unknown[] }).peers
        : [];

    return NextResponse.json(peers.map((peer) => toPeer(peer)));
  } catch {
    return NextResponse.json(mockPeers());
  }
}
