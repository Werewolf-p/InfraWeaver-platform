import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createARecord } from "@/lib/cloudflare";

const GAME_TYPE_DEFAULTS: Record<string, { ports: Array<{ port: number; protocol: string; name: string }>; icon: string; color: string }> = {
  minecraft:  { ports: [{ port: 25565, protocol: "TCP", name: "game" }], icon: "⛏", color: "green" },
  valheim:    { ports: [{ port: 2456, protocol: "UDP", name: "game" }, { port: 2457, protocol: "UDP", name: "rcon" }], icon: "🪓", color: "blue" },
  cs2:        { ports: [{ port: 27015, protocol: "TCP", name: "game" }, { port: 27015, protocol: "UDP", name: "game" }], icon: "🔫", color: "orange" },
  terraria:   { ports: [{ port: 7777, protocol: "TCP", name: "game" }], icon: "🌍", color: "purple" },
  factorio:   { ports: [{ port: 34197, protocol: "UDP", name: "game" }], icon: "⚙", color: "yellow" },
  rust:       { ports: [{ port: 28015, protocol: "TCP", name: "game" }, { port: 28016, protocol: "TCP", name: "rcon" }], icon: "🏚", color: "red" },
  custom:     { ports: [], icon: "🎮", color: "gray" },
};

// Suppress unused variable warning — kept for potential future use
void GAME_TYPE_DEFAULTS;

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

    const servers = services.map((svc: {
      metadata?: { name?: string; annotations?: Record<string, string>; creationTimestamp?: Date };
      spec?: { loadBalancerIP?: string; ports?: Array<{ port: number; protocol?: string; name?: string }> };
      status?: { loadBalancer?: { ingress?: Array<{ ip?: string }> } };
    }) => {
      const meta = svc.metadata ?? {};
      const spec = svc.spec ?? {};
      const annotations = meta.annotations ?? {};
      return {
        name: meta.name ?? "",
        displayName: annotations["infraweaver.io/display-name"] ?? meta.name ?? "",
        gameType: annotations["infraweaver.io/game-type"] ?? "custom",
        allocatedIP: spec.loadBalancerIP ?? annotations["infraweaver.io/allocated-ip"] ?? null,
        ports: (spec.ports ?? []).map((p: { port: number; protocol?: string; name?: string }) => ({
          port: p.port,
          protocol: p.protocol ?? "TCP",
          name: p.name ?? "",
        })),
        backendType: annotations["infraweaver.io/backend-type"] ?? "external",
        description: annotations["infraweaver.io/description"] ?? "",
        publicDns: annotations["infraweaver.io/public-dns"] === "true",
        internalDns: annotations["infraweaver.io/internal-dns"] === "true",
        createdAt: meta.creationTimestamp?.toISOString() ?? null,
        status: svc.status?.loadBalancer?.ingress?.[0]?.ip ? "active" : "pending",
      };
    });

    return NextResponse.json(servers);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    name: string;
    displayName: string;
    gameType: string;
    ports: Array<{ port: number; protocol: "TCP" | "UDP"; name: string }>;
    backendType: "external" | "in-cluster";
    backendIP?: string;
    backendPort?: number;
    publicDns: boolean;
    internalDns: boolean;
    allocatedIP?: string;
    description?: string;
  };

  const { name, displayName, gameType, ports, backendType, backendIP, publicDns, internalDns, allocatedIP, description } = body;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const svc = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name,
        namespace: "game-servers",
        labels: {
          "app": name,
          "infraweaver.io/type": "gameserver",
          "infraweaver.io/game-type": gameType,
        },
        annotations: {
          "metallb.universe.tf/address-pool": "game-servers-pool",
          "infraweaver.io/display-name": displayName,
          "infraweaver.io/game-type": gameType,
          "infraweaver.io/backend-type": backendType,
          "infraweaver.io/public-dns": String(publicDns),
          "infraweaver.io/internal-dns": String(internalDns),
          "infraweaver.io/description": description ?? "",
          ...(allocatedIP ? { "metallb.universe.tf/loadBalancerIPs": allocatedIP, "infraweaver.io/allocated-ip": allocatedIP } : {}),
        },
      },
      spec: {
        type: "LoadBalancer",
        ...(allocatedIP ? { loadBalancerIP: allocatedIP } : {}),
        ports: ports.map(p => ({
          name: p.name,
          port: p.port,
          targetPort: p.port,
          protocol: p.protocol,
        })),
        selector: backendType === "in-cluster" ? { app: name } : undefined,
      },
    };

    await coreApi.createNamespacedService({ namespace: "game-servers", body: svc });

    if (backendType === "external" && backendIP && body.backendPort) {
      const endpoints = {
        apiVersion: "v1",
        kind: "Endpoints",
        metadata: { name, namespace: "game-servers" },
        subsets: [{
          addresses: [{ ip: backendIP }],
          ports: ports.map(p => ({ name: p.name, port: body.backendPort ?? p.port, protocol: p.protocol })),
        }],
      };
      await coreApi.createNamespacedEndpoints({ namespace: "game-servers", body: endpoints });
    }

    const cm = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: `${name}-meta`,
        namespace: "game-servers",
        labels: { "infraweaver.io/type": "gameserver-meta", "infraweaver.io/server": name },
      },
      data: {
        gameType,
        displayName,
        description: description ?? "",
        backendType,
        backendIP: backendIP ?? "",
        icon: GAME_TYPE_DEFAULTS[gameType]?.icon ?? "🎮",
        color: GAME_TYPE_DEFAULTS[gameType]?.color ?? "gray",
        createdAt: new Date().toISOString(),
      },
    };
    await coreApi.createNamespacedConfigMap({ namespace: "game-servers", body: cm });

    const ip = allocatedIP;
    if (ip) {
      if (publicDns) {
        try { await createARecord(`${name}.rlservers.com`, ip, false); } catch {}
      }
      if (internalDns) {
        try { await createARecord(`${name}.int.rlservers.com`, ip, false); } catch {}
      }
    }

    return NextResponse.json({ success: true, name });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
