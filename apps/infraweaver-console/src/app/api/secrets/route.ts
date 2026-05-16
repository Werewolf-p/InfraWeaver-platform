import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { getRequestClusterId } from "@/lib/cluster-context";
import { requireRoutePermissions } from "@/lib/route-utils";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

interface SecretSummary {
  name: string;
  namespace: string;
  type: string;
  age: string | null;
  keyCount: number;
  keyNames: string[];
  externalSecret: string | null;
}

interface ExternalSecretSummary {
  name: string;
  namespace: string;
  targetSecret: string;
}

function secretKey(namespace: string, name: string) {
  return `${namespace}/${name}`;
}

function sortSecrets(items: SecretSummary[]) {
  return items.sort((left, right) => {
    const namespaceDiff = left.namespace.localeCompare(right.namespace);
    return namespaceDiff !== 0 ? namespaceDiff : left.name.localeCompare(right.name);
  });
}

async function listExternalSecrets(customApi: k8s.CustomObjectsApi): Promise<ExternalSecretSummary[]> {
  try {
    const response = await customApi.listClusterCustomObject({
      group: "external-secrets.io",
      version: "v1beta1",
      plural: "externalsecrets",
    });

    const items = ((response as { items?: unknown[] }).items ?? []);
    return items.map((item) => {
      const externalSecret = item as {
        metadata?: { name?: string; namespace?: string };
        spec?: { target?: { name?: string } };
      };

      const namespace = externalSecret.metadata?.namespace ?? "default";
      const name = externalSecret.metadata?.name ?? "";
      return {
        name,
        namespace,
        targetSecret: externalSecret.spec?.target?.name ?? name,
      };
    });
  } catch {
    return [];
  }
}

const deleteSchema = z.object({
  namespace: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
});


export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const namespace = request.nextUrl.searchParams.get("namespace");

  try {
    const kubeConfig = loadKubeConfig(getRequestClusterId(request));
    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

    const [secretResponse, externalSecrets] = await Promise.all([
      namespace && namespace !== "all"
        ? coreApi.listNamespacedSecret({ namespace })
        : coreApi.listSecretForAllNamespaces(),
      listExternalSecrets(customApi),
    ]);

    const managedSecrets = new Map(
      externalSecrets.map((item) => [secretKey(item.namespace, item.targetSecret), `${item.namespace}/${item.name}`] as const),
    );

    const secrets = sortSecrets(secretResponse.items.map((secret) => {
      const metadataNamespace = secret.metadata?.namespace ?? "default";
      const metadataName = secret.metadata?.name ?? "";
      const keyNames = Object.keys(secret.data ?? {}).sort();
      const ownerReference = secret.metadata?.ownerReferences?.find((owner) => owner.kind === "ExternalSecret")?.name ?? null;

      return {
        name: metadataName,
        namespace: metadataNamespace,
        type: secret.type ?? "Opaque",
        age: secret.metadata?.creationTimestamp?.toISOString() ?? null,
        keyCount: keyNames.length,
        keyNames,
        externalSecret: ownerReference
          ? `${metadataNamespace}/${ownerReference}`
          : managedSecrets.get(secretKey(metadataNamespace, metadataName)) ?? null,
      };
    }));

    return NextResponse.json({ secrets });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
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
    await coreApi.deleteNamespacedSecret({ namespace, name });
    return NextResponse.json({ ok: true, namespace, name });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 502 });
  }
}
