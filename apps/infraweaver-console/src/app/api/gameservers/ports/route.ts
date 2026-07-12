import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { makeCoreApi } from "@/lib/kube-client";
import { safeError } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const coreApi = makeCoreApi();

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
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
