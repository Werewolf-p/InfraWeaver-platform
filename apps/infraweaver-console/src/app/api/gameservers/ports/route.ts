import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const cmList = await coreApi.listNamespacedConfigMap({ namespace: "game-servers" });
    const configMaps = (cmList.items ?? []).filter((cm: { metadata?: { labels?: Record<string, string> } }) =>
      cm.metadata?.labels?.["infraweaver.io/type"] === "gameserver"
    );

    const servers = configMaps.map((cm: {
      metadata?: { name?: string };
      data?: Record<string, string>;
    }) => {
      const name = cm.metadata?.name ?? "";
      const data = cm.data ?? {};
      const targetIP = data["target-ip"] ?? "";
      const ports: Array<{ port: number; protocol: string; name: string }> = (() => {
        try { return JSON.parse(data["ports"] ?? "[]"); } catch { return []; }
      })();
      return { name, targetIP, ports };
    });

    // Detect conflicts: same targetIP + port + protocol used by 2+ servers
    const portMap = new Map<string, string[]>();
    for (const server of servers) {
      for (const p of server.ports) {
        const key = `${server.targetIP}:${p.port}:${p.protocol}`;
        if (!portMap.has(key)) portMap.set(key, []);
        portMap.get(key)!.push(server.name);
      }
    }

    const conflicts: Array<{ ip: string; port: number; protocol: string; servers: string[] }> = [];
    for (const [key, names] of portMap.entries()) {
      if (names.length > 1) {
        const [ip, portStr, protocol] = key.split(":");
        conflicts.push({ ip, port: parseInt(portStr), protocol, servers: names });
      }
    }

    return NextResponse.json({ servers, conflicts });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
