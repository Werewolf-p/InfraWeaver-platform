import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { getRequestClusterId } from "@/lib/cluster-context";
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

const deleteSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
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

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const namespace = request.nextUrl.searchParams.get("namespace");

  try {
    const coreApi = loadKubeConfig(getRequestClusterId(request)).makeApiClient(k8s.CoreV1Api);
    const response = namespace && namespace !== "all"
      ? await coreApi.listNamespacedConfigMap({ namespace })
      : await coreApi.listConfigMapForAllNamespaces();

    const configMaps = sortConfigMaps(response.items.map((item) => toSummary(item)));
    return NextResponse.json({ configMaps });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
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
  const clusterId = getRequestClusterId(request);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNamespacedConfigMap({
      name,
      namespace,
      body: { data },
      fieldManager: "infraweaver",
    });

    const updated = await coreApi.readNamespacedConfigMap({ name, namespace });
    return NextResponse.json({ ok: true, configMap: toSummary(updated) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { namespace, name } = parsed.data;
  const clusterId = getRequestClusterId(request);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.deleteNamespacedConfigMap({ namespace, name });
    return NextResponse.json({ ok: true, namespace, name });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 502 });
  }
}
