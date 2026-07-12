import { NextResponse } from "next/server";
import {
  GAME_HUB_NS,
  getKubernetesErrorStatus,
  getNodeIp,
  getServerPod,
  makeGameHubClients,
  tcpProbe,
  withGameHubAuth,
} from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

type ConnectivityStatus = "open" | "closed" | "unverified" | "unknown";

function normalizeProtocol(protocol: string | null | undefined) {
  return String(protocol ?? "TCP").toUpperCase() === "UDP" ? "UDP" : "TCP";
}

function buildUnknownConnectivity(message: string) {
  return {
    status: "unknown" as const,
    message,
    internal: { ready: false, clusterIP: null, port: null, message },
    external: {
      status: "unknown" as const,
      open: null,
      host: null,
      port: null,
      protocol: null,
      latencyMs: null,
      message,
    },
    ports: [],
  };
}

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
  try {
    const { coreApi } = makeGameHubClients();
    let connectivityMessage: string | null = null;
    const noteConnectivityIssue = (error: unknown, fallbackMessage: string) => {
      const nextMessage = getKubernetesErrorStatus(error) === 403
        ? "insufficient permissions"
        : fallbackMessage;
      connectivityMessage ??= nextMessage;
      return null;
    };

    const [service, pod] = await Promise.all([
      coreApi
        .readNamespacedService({ name, namespace: GAME_HUB_NS })
        .catch((error) => noteConnectivityIssue(error, "service unavailable")),
      getServerPod(coreApi, name).catch((error) => noteConnectivityIssue(error, "pod unavailable")),
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
      noteConnectivityIssue(error, "endpoint lookup unavailable");
      console.error("connectivity endpoint lookup failed", error);
    }

    let host: string | null = null;
    try {
      host = await getNodeIp(coreApi, pod);
    } catch (error) {
      noteConnectivityIssue(error, "node IP unavailable");
      console.error("connectivity node IP lookup failed", error);
    }

    const ports = await Promise.all(
      (service?.spec?.ports ?? []).map(async (servicePort) => {
        const protocol = normalizeProtocol(servicePort.protocol);
        const servicePortNumber = servicePort.port ?? null;
        const nodePort = servicePort.nodePort ?? null;
        const basePort = {
          name: servicePort.name ?? null,
          servicePort: servicePortNumber,
          nodePort,
          protocol,
          message: connectivityMessage,
        };
        if (connectivityMessage || !host) {
          return {
            ...basePort,
            status: "unknown" as ConnectivityStatus,
            open: null,
            latencyMs: null,
          };
        }
        if (protocol === "UDP") {
          return {
            ...basePort,
            status: "unverified" as ConnectivityStatus,
            open: null,
            latencyMs: null,
          };
        }

        const external = await tcpProbe(host, nodePort ?? servicePortNumber);
        return {
          ...basePort,
          status: (external.open ? "open" : "closed") as ConnectivityStatus,
          open: external.open,
          latencyMs: external.latencyMs,
        };
      }),
    );
    const primaryPort = ports[0] ?? null;
    const externalStatus = connectivityMessage
      ? "unknown"
      : primaryPort?.status ?? "unknown";

    return NextResponse.json({
      status: externalStatus,
      message: connectivityMessage,
      internal: { ready: internalReady, clusterIP, port, message: connectivityMessage },
      external: {
        status: externalStatus,
        open: connectivityMessage ? null : primaryPort?.open ?? null,
        host,
        port: primaryPort?.nodePort ?? primaryPort?.servicePort ?? null,
        protocol: primaryPort?.protocol ?? null,
        latencyMs: connectivityMessage ? null : primaryPort?.latencyMs ?? null,
        message: connectivityMessage,
      },
      ports,
    });
  } catch (error) {
    console.error("connectivity route failed", error);
    const message = getKubernetesErrorStatus(error) === 403
      ? "insufficient permissions"
      : safeError(error) || "connectivity unavailable";
    return NextResponse.json(buildUnknownConnectivity(message), { status: 200 });
  }
});
