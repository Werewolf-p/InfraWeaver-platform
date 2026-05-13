import net from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import {
  GAME_HUB_NS,
  getNodeIp,
  getServerPod,
  makeGameHubClients,
} from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

async function checkTcpConnect(host: string | null, port: number | null) {
  if (!host || !port) {
    return { open: false, latencyMs: null };
  }

  return new Promise<{ open: boolean; latencyMs: number | null }>((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, latencyMs: open ? Date.now() - startedAt : null });
    };

    socket.setTimeout(3000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:read",
      name,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { coreApi } = makeGameHubClients();
    const [service, pod] = await Promise.all([
      coreApi
        .readNamespacedService({ name, namespace: GAME_HUB_NS })
        .catch(() => null),
      getServerPod(coreApi, name).catch(() => null),
    ]);
    const clusterIP =
      service?.spec?.clusterIP && service.spec.clusterIP !== "None"
        ? service.spec.clusterIP
        : null;
    const port = service?.spec?.ports?.[0]?.port ?? null;

    let internalReady = false;
    try {
      const endpoints = await coreApi.readNamespacedEndpoints({
        name,
        namespace: GAME_HUB_NS,
      });
      internalReady = Boolean(
        endpoints.subsets?.some(
          (subset) => (subset.addresses?.length ?? 0) > 0,
        ),
      );
    } catch (error) {
      console.error("connectivity endpoint lookup failed", error);
    }

    const host = await getNodeIp(coreApi, pod);
    const nodePort = service?.spec?.ports?.[0]?.nodePort ?? null;
    const external = await checkTcpConnect(host, nodePort);

    return NextResponse.json({
      internal: { ready: internalReady, clusterIP, port },
      external: {
        open: external.open,
        host,
        port: nodePort,
        latencyMs: external.latencyMs,
      },
    });
  } catch (error) {
    console.error("connectivity route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
