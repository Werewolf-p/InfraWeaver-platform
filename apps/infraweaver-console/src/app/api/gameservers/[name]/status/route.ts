import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as net from "net";

async function tcpCheck(host: string, port: number, timeout = 3000): Promise<{ open: boolean; latencyMs: number }> {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve({ open: true, latencyMs: Date.now() - start }); });
    socket.on("timeout", () => { socket.destroy(); resolve({ open: false, latencyMs: timeout }); });
    socket.on("error", () => resolve({ open: false, latencyMs: Date.now() - start }));
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

    const cm = await coreApi.readNamespacedConfigMap({ name, namespace: "game-servers" });
    const data = cm.data ?? {};
    const targetIP = data["target-ip"] ?? "";
    const ports: Array<{ port: number; protocol: string; name: string }> = (() => {
      try { return JSON.parse(data["ports"] ?? "[]"); } catch { return []; }
    })();

    if (!targetIP || ports.length === 0) {
      return NextResponse.json({ online: false, latencyMs: 0, checkedAt: new Date().toISOString() });
    }

    // Check first TCP port
    const tcpPorts = ports.filter(p => p.protocol === "TCP" || !p.protocol);
    if (tcpPorts.length === 0) {
      return NextResponse.json({ online: false, latencyMs: 0, checkedAt: new Date().toISOString() });
    }

    const { open, latencyMs } = await tcpCheck(targetIP, tcpPorts[0].port);
    return NextResponse.json({ online: open, latencyMs, checkedAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
