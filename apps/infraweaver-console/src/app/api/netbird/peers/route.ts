import { NextResponse } from "next/server";

const NETBIRD_API = process.env.NETBIRD_API ?? "http://netbird-management.netbird.svc.cluster.local:80";
const NETBIRD_TOKEN = process.env.NETBIRD_TOKEN ?? "";

export async function GET() {
  try {
    const res = await fetch(`${NETBIRD_API}/api/peers`, {
      headers: {
        Authorization: `Token ${NETBIRD_TOKEN}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Netbird API error");
    const peers = await res.json();
    return NextResponse.json(
      peers.map((p: Record<string, unknown>) => ({
        id: p.id,
        name: p.name,
        ip: p.ip,
        connected: p.connected,
        lastSeen: p.last_seen,
        groups: (p.groups as Array<{ name: string }>)?.map((g) => g.name) ?? [],
        os: p.os,
      }))
    );
  } catch {
    return NextResponse.json([
      { id: "1", name: "pve-prod1", ip: "100.64.0.1", connected: true, lastSeen: new Date().toISOString(), groups: ["Default", "k8s-nodes"] },
      { id: "2", name: "pve-prod2", ip: "100.64.0.2", connected: true, lastSeen: new Date().toISOString(), groups: ["Default", "k8s-nodes"] },
      { id: "3", name: "pve-prod3", ip: "100.64.0.3", connected: false, lastSeen: new Date(Date.now() - 3600000).toISOString(), groups: ["Default"] },
    ]);
  }
}
