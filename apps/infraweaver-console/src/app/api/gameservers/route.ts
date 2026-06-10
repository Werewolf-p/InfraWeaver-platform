import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { GET as getGameHubServers } from "@/app/api/game-hub/servers/route";
import { createARecord, deleteARecord } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { internalHost, publicHost } from "@/lib/domain";

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const createGameserverSchema = z.object({
  name: z.string().regex(SLUG_REGEX, "Must be a DNS-safe slug"),
  displayName: z.string().min(1),
  gameType: z.string().min(1),
  targetIP: z.string().regex(IP_REGEX, "Must be a valid IP address"),
  internalIP: z.string().optional(),
  ports: z.array(z.object({ port: z.number(), protocol: z.enum(["TCP", "UDP"]), name: z.string() })),
  backendType: z.enum(["external", "in-cluster"]),
  publicDns: z.boolean(),
  internalDns: z.boolean(),
  description: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const cmList = await coreApi.listNamespacedConfigMap({ namespace: "game-servers" });
    const configMaps = (cmList.items ?? []).filter((cm: { metadata?: { labels?: Record<string, string> } }) =>
      cm.metadata?.labels?.["infraweaver.io/type"] === "gameserver"
    );

    const servers = await Promise.all(configMaps.map(async (cm: {
      metadata?: { name?: string; creationTimestamp?: Date; labels?: Record<string, string> };
      data?: Record<string, string>;
    }) => {
      const name = cm.metadata?.name ?? "";
      const data = cm.data ?? {};
      const backendType = data["backend-type"] ?? "external";

      let serviceStatus = "unknown";
      if (backendType === "in-cluster") {
        try {
          const svc = await coreApi.readNamespacedService({ name, namespace: "game-servers" });
          serviceStatus = svc.status?.loadBalancer?.ingress?.[0]?.ip ? "active" : "pending";
        } catch {
          serviceStatus = "missing";
        }
      } else {
        serviceStatus = "external";
      }

      return {
        name,
        displayName: data["display-name"] ?? name,
        gameType: data["game-type"] ?? "custom",
        targetIP: data["target-ip"] ?? "",
        internalIP: data["internal-ip"] ?? "",
        ports: (() => { try { return JSON.parse(data["ports"] ?? "[]"); } catch { return []; } })(),
        backendType,
        publicDns: data["public-dns"] === "true",
        internalDns: data["internal-dns"] === "true",
        description: data["description"] ?? "",
        createdAt: cm.metadata?.creationTimestamp?.toISOString() ?? null,
        serviceStatus,
      };
    }));

    if (servers.length === 0) {
      return getGameHubServers(req, { params: Promise.resolve({}) });
    }

    return NextResponse.json(servers);
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rawBody = await req.json().catch(() => ({}));
  const parsedBody = createGameserverSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { name, displayName, gameType, targetIP, internalIP, ports, backendType, publicDns, internalDns, description } = parsedBody.data;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Create ConfigMap (primary data store)
    const cm = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name,
        namespace: "game-servers",
        labels: {
          "infraweaver.io/type": "gameserver",
          "infraweaver.io/game-type": gameType,
        },
      },
      data: {
        "display-name": displayName,
        "game-type": gameType,
        "target-ip": targetIP,
        "internal-ip": internalIP ?? "",
        "ports": JSON.stringify(ports),
        "backend-type": backendType,
        "public-dns": String(publicDns),
        "internal-dns": String(internalDns),
        "description": description ?? "",
      },
    };
    await coreApi.createNamespacedConfigMap({ namespace: "game-servers", body: cm });

    // For in-cluster: also create a K8s Service with MetalLB
    if (backendType === "in-cluster") {
      const svc = {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name,
          namespace: "game-servers",
          labels: {
            "app": name,
            "infraweaver.io/type": "gameserver-service",
            "infraweaver.io/game-type": gameType,
          },
          annotations: {
            "metallb.universe.tf/loadBalancerIPs": targetIP,
          },
        },
        spec: {
          type: "LoadBalancer",
          loadBalancerIP: targetIP,
          ports: ports.map(p => ({
            name: p.name,
            port: p.port,
            targetPort: p.port,
            protocol: p.protocol,
          })),
          selector: { app: name },
        },
      };
      await coreApi.createNamespacedService({ namespace: "game-servers", body: svc });
    }

    // Create DNS records
    const dnsIP = targetIP;
    const intDnsIP = internalIP || targetIP;
    if (publicDns) {
      try { await deleteARecord(publicHost(name)); } catch {}
      try { await createARecord(publicHost(name), dnsIP, false); } catch {}
    }
    if (internalDns) {
      try { await deleteARecord(internalHost(name)); } catch {}
      try { await createARecord(internalHost(name), intDnsIP, false); } catch {}
    }

    return NextResponse.json({ success: true, name });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
