import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const GAME_HUB_NS = "game-hub";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const deployments = await appsApi.listNamespacedDeployment({
      namespace: GAME_HUB_NS,
      labelSelector: "infraweaver/game=true",
    });

    const servers = await Promise.all((deployments.items ?? []).map(async (d) => {
      const name = d.metadata?.name ?? "";
      const gameType = d.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
      const replicas = d.status?.replicas ?? 0;
      const readyReplicas = d.status?.readyReplicas ?? 0;
      let status = "stopped";
      if (d.spec?.replicas === 0) status = "stopped";
      else if (readyReplicas > 0) status = "running";
      else if (replicas > 0) status = "starting";

      let podName = "";
      try {
        const pods = await coreApi.listNamespacedPod({
          namespace: GAME_HUB_NS,
          labelSelector: `app=${name}`,
        });
        const pod = pods.items?.[0];
        podName = pod?.metadata?.name ?? "";
      } catch {}

      let nodePort = 0;
      let port = 0;
      try {
        const svc = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NS });
        port = svc.spec?.ports?.[0]?.port ?? 0;
        nodePort = svc.spec?.ports?.[0]?.nodePort ?? 0;
      } catch {}

      return {
        name,
        gameType,
        status,
        replicas,
        readyReplicas,
        podName,
        port,
        nodePort,
        memory: d.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? "",
        cpu: d.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? "",
        createdAt: d.metadata?.creationTimestamp ?? null,
      };
    }));

    return NextResponse.json({ servers });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json() as {
      game: string;
      name: string;
      memory?: string;
      cpu?: string;
      storage?: string;
      env?: Record<string, string>;
      port?: number;
    };

    const { game, name, memory = "2Gi", cpu = "1", storage = "10Gi", env = {}, port } = body;

    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const GAME_CONFIGS: Record<string, { image: string; containerPort: number; protocol: string; mountPath: string; defaultEnv: Record<string, string> }> = {
      minecraft: {
        image: "itzg/minecraft-server:latest",
        containerPort: 25565,
        protocol: "TCP",
        mountPath: "/data",
        defaultEnv: { EULA: "TRUE", TYPE: "PAPER", VERSION: "LATEST", MEMORY: memory.replace("Gi", "000M").replace("Mi", "M") },
      },
      terraria: {
        image: "ryshe/terraria:latest",
        containerPort: 7777,
        protocol: "TCP",
        mountPath: "/world",
        defaultEnv: { WORLD: "World1", MAXPLAYERS: "20", PASSWORD: "", AUTOCREATE: "2" },
      },
      valheim: {
        image: "lloesche/valheim-server:latest",
        containerPort: 2456,
        protocol: "UDP",
        mountPath: "/config",
        defaultEnv: { SERVER_NAME: name, WORLD_NAME: "MyWorld", SERVER_PASS: "changeme", SERVER_PUBLIC: "false" },
      },
    };

    const cfg = GAME_CONFIGS[game];
    if (!cfg) return NextResponse.json({ error: `Unknown game: ${game}` }, { status: 400 });

    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const mergedEnv = { ...cfg.defaultEnv, ...env };
    const envVars = Object.entries(mergedEnv).map(([k, v]) => ({ name: k, value: v }));

    // Create PVC
    await coreApi.createNamespacedPersistentVolumeClaim({
      namespace: GAME_HUB_NS,
      body: {
        metadata: { name: `${slug}-data`, namespace: GAME_HUB_NS, labels: { app: slug, "infraweaver/game": "true" } },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "longhorn",
          resources: { requests: { storage } },
        },
      },
    });

    // Create Deployment
    await appsApi.createNamespacedDeployment({
      namespace: GAME_HUB_NS,
      body: {
        metadata: {
          name: slug,
          namespace: GAME_HUB_NS,
          labels: { app: slug, "infraweaver/game": "true", "infraweaver/game-type": game },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: slug } },
          template: {
            metadata: { labels: { app: slug, "infraweaver/game": "true" } },
            spec: {
              securityContext: game === "valheim" ? { runAsUser: 0 } : { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              containers: [{
                name: game,
                image: cfg.image,
                ports: [{ containerPort: cfg.containerPort, protocol: cfg.protocol as "TCP" | "UDP" }],
                env: envVars,
                resources: {
                  requests: { memory: "512Mi", cpu: "250m" },
                  limits: { memory, cpu },
                },
                volumeMounts: [{ name: "data", mountPath: cfg.mountPath }],
              }],
              volumes: [{ name: "data", persistentVolumeClaim: { claimName: `${slug}-data` } }],
            },
          },
        },
      },
    });

    // Create Service
    await coreApi.createNamespacedService({
      namespace: GAME_HUB_NS,
      body: {
        metadata: { name: slug, namespace: GAME_HUB_NS, labels: { app: slug, "infraweaver/game": "true" } },
        spec: {
          type: "NodePort",
          selector: { app: slug },
          ports: [{ port: port ?? cfg.containerPort, targetPort: cfg.containerPort, protocol: cfg.protocol as "TCP" | "UDP" }],
        },
      },
    });

    return NextResponse.json({ name: slug, game, status: "creating" }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
