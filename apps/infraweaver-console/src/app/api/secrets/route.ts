import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { requireRoutePermissions } from "@/lib/route-utils";
import { loadKubeConfig } from "@/lib/k8s";

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
    return [
      { name: "netbird-management", namespace: "netbird", targetSecret: "netbird-management-token" },
      { name: "authentik-oauth", namespace: "authentik", targetSecret: "authentik-oauth-secret" },
    ];
  }
}

function mockSecrets(): SecretSummary[] {
  return sortSecrets([
    {
      name: "netbird-management-token",
      namespace: "netbird",
      type: "Opaque",
      age: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      keyCount: 2,
      keyNames: ["token", "account"],
      externalSecret: "netbird/netbird-management",
    },
    {
      name: "authentik-oauth-secret",
      namespace: "authentik",
      type: "Opaque",
      age: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      keyCount: 3,
      keyNames: ["client-id", "client-secret", "issuer"],
      externalSecret: "authentik/authentik-oauth",
    },
  ]);
}

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const namespace = request.nextUrl.searchParams.get("namespace");

  try {
    const kubeConfig = loadKubeConfig();
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
    const secrets = namespace && namespace !== "all"
      ? mockSecrets().filter((item) => item.namespace === namespace)
      : mockSecrets();
    return NextResponse.json({ secrets, live: false });
  }
}
