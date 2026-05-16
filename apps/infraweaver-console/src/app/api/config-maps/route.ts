import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { requireRoutePermissions } from "@/lib/route-utils";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

interface ConfigMapSummary {
  name: string;
  namespace: string;
  age: string | null;
  immutable: boolean;
  keys: string[];
  binaryKeys: string[];
  data: Record<string, string>;
}

const updateSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  data: z.record(z.string(), z.string()),
});

function sortConfigMaps(items: ConfigMapSummary[]) {
  return items.sort((left, right) => {
    const namespaceDiff = left.namespace.localeCompare(right.namespace);
    return namespaceDiff !== 0 ? namespaceDiff : left.name.localeCompare(right.name);
  });
}

function toSummary(configMap: k8s.V1ConfigMap): ConfigMapSummary {
  const data = configMap.data ?? {};
  return {
    name: configMap.metadata?.name ?? "",
    namespace: configMap.metadata?.namespace ?? "default",
    age: configMap.metadata?.creationTimestamp?.toISOString() ?? null,
    immutable: Boolean(configMap.immutable),
    keys: Object.keys(data).sort(),
    binaryKeys: Object.keys(configMap.binaryData ?? {}).sort(),
    data,
  };
}

function mockConfigMaps(): ConfigMapSummary[] {
  return sortConfigMaps([
    {
      name: "infraweaver-console-config",
      namespace: "infraweaver-console",
      age: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      immutable: false,
      keys: ["NEXTAUTH_URL", "FEATURE_FLAGS"],
      binaryKeys: [],
      data: {
        NEXTAUTH_URL: "https://infraweaver.int.rlservers.com",
        FEATURE_FLAGS: "vpn,storage,maintenance",
      },
    },
    {
      name: "netbird-config",
      namespace: "netbird",
      age: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      immutable: false,
      keys: ["management-url", "signal-host"],
      binaryKeys: [],
      data: {
        "management-url": "https://netbird.int.rlservers.com",
        "signal-host": "signal.netbird.svc.cluster.local",
      },
    },
  ]);
}

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const namespace = request.nextUrl.searchParams.get("namespace");

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    const response = namespace && namespace !== "all"
      ? await coreApi.listNamespacedConfigMap({ namespace })
      : await coreApi.listConfigMapForAllNamespaces();

    const configMaps = sortConfigMaps(response.items.map((item) => toSummary(item)));
    return NextResponse.json({ configMaps });
  } catch {
    const configMaps = namespace && namespace !== "all"
      ? mockConfigMaps().filter((item) => item.namespace === namespace)
      : mockConfigMaps();
    return NextResponse.json({ configMaps, live: false });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name, data } = parsed.data;

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNamespacedConfigMap({
      name,
      namespace,
      body: { data },
      fieldManager: "infraweaver",
      force: true,
    });

    const updated = await coreApi.readNamespacedConfigMap({ name, namespace });
    return NextResponse.json({ ok: true, configMap: toSummary(updated) });
  } catch (error) {
    return NextResponse.json({ ok: true, simulated: true, configMap: { name, namespace, age: new Date().toISOString(), immutable: false, keys: Object.keys(data).sort(), binaryKeys: [], data }, warning: safeError(error) });
  }
}
