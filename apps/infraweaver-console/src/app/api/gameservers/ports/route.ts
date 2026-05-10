import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const POOL_IPS = ["10.10.0.206", "10.10.0.207", "10.10.0.208", "10.10.0.209", "10.10.0.210"];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const svcList = await coreApi.listNamespacedService({ namespace: "game-servers" });
    const services = (svcList.items ?? []).filter((s: { metadata?: { labels?: Record<string, string> } }) =>
      s.metadata?.labels?.["infraweaver.io/type"] === "gameserver"
    );

    const usedIPs = services.map((s: { spec?: { loadBalancerIP?: string }; metadata?: { annotations?: Record<string, string> } }) =>
      s.spec?.loadBalancerIP ?? s.metadata?.annotations?.["infraweaver.io/allocated-ip"]
    ).filter(Boolean) as string[];

    const usedPorts: Array<{ ip: string; port: number; protocol: string; serverName: string }> = [];

    for (const svc of services) {
      const ip = (svc as { spec?: { loadBalancerIP?: string } }).spec?.loadBalancerIP ?? "";
      const name = (svc as { metadata?: { name?: string } }).metadata?.name ?? "";
      for (const p of (svc as { spec?: { ports?: Array<{ port: number; protocol?: string }> } }).spec?.ports ?? []) {
        usedPorts.push({ ip, port: p.port, protocol: p.protocol ?? "TCP", serverName: name });
      }
    }

    const availableIPs = POOL_IPS.filter(ip => !usedIPs.includes(ip));

    return NextResponse.json({ availableIPs, usedIPs, usedPorts, poolIPs: POOL_IPS });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
