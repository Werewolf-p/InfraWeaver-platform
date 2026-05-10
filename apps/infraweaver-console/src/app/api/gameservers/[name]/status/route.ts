import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as net from "net";

async function tcpCheck(host: string, port: number, timeout = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
    socket.connect(port, host);
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const svc = await coreApi.readNamespacedService({ name, namespace: "game-servers" });
    const ip = svc.status?.loadBalancer?.ingress?.[0]?.ip ?? svc.spec?.loadBalancerIP;
    const ports = svc.spec?.ports ?? [];

    if (!ip || ports.length === 0) {
      return NextResponse.json({ status: "no-ip", portChecks: [] });
    }

    const portChecks = await Promise.all(
      ports
        .filter((p: { protocol?: string }) => p.protocol === "TCP" || !p.protocol)
        .map(async (p: { port: number; protocol?: string; name?: string }) => ({
          port: p.port,
          protocol: p.protocol ?? "TCP",
          name: p.name ?? "",
          open: await tcpCheck(ip, p.port),
        }))
    );

    const anyOpen = portChecks.some((pc: { open: boolean }) => pc.open);
    return NextResponse.json({ status: anyOpen ? "online" : "offline", ip, portChecks });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
