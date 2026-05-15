import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createARecord, deleteARecord } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export async function GET() {
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

  const body = await req.json() as {
    name: string;
    displayName: string;
    gameType: string;
    targetIP: string;
    internalIP?: string;
    ports: Array<{ port: number; protocol: "TCP" | "UDP"; name: string }>;
    backendType: "external" | "in-cluster";
    publicDns: boolean;
    internalDns: boolean;
    description?: string;
  };

  const { name, displayName, gameType, targetIP, internalIP, ports, backendType, publicDns, internalDns, description } = body;

  if (!name || !SLUG_REGEX.test(name)) {
    return NextResponse.json({ error: "Invalid name: must be a DNS-safe slug" }, { status: 400 });
  }
  if (!targetIP || !IP_REGEX.test(targetIP)) {
    return NextResponse.json({ error: "Invalid targetIP: must be a valid IP address" }, { status: 400 });
  }

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
      try { await deleteARecord(`${name}.rlservers.com`); } catch {}
      try { await createARecord(`${name}.rlservers.com`, dnsIP, false); } catch {}
    }
    if (internalDns) {
      try { await deleteARecord(`${name}.int.rlservers.com`); } catch {}
      try { await createARecord(`${name}.int.rlservers.com`, intDnsIP, false); } catch {}
    }

    return NextResponse.json({ success: true, name });
  } catch (e) {
    return NextResponse.json({ error: safeError(e) }, { status: 500 });
  }
}
