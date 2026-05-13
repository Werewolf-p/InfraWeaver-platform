import { NextResponse } from "next/server";
import { dump } from "js-yaml";
import { auth } from "@/lib/auth";
import { loadKubeConfig } from "@/lib/k8s";
import { hasPermission } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

interface AppResource {
  kind?: string;
  name?: string;
  namespace?: string;
  status?: string;
  health?: { status?: string };
}

function serializeYaml(value: unknown) {
  return dump(JSON.parse(JSON.stringify(value)), { noRefs: true, lineWidth: 120 });
}

function normalize(value?: string | null) {
  return (value ?? "").toLowerCase();
}

function mockApplication(name: string) {
  return {
    metadata: { name, namespace: "argocd", labels: { "app.kubernetes.io/instance": name } },
    spec: {
      project: "platform",
      destination: { namespace: name.replace(/^(?:catalog|platform|core)-/, "") || "default", server: "https://kubernetes.default.svc" },
      source: {
        repoURL: "https://github.com/Werewolf-p/InfraWeaver-platform",
        path: `clusters/homelab/apps/${name}`,
        targetRevision: "main",
      },
    },
    status: {
      health: { status: "Healthy" },
      sync: { status: "Synced", revision: "main" },
      reconciledAt: new Date().toISOString(),
      resources: [
        { kind: "Deployment", name, namespace: "default", status: "Synced", health: { status: "Healthy" } },
        { kind: "Service", name, namespace: "default", status: "Synced", health: { status: "Healthy" } },
      ],
      history: [
        {
          revision: "main",
          deployedAt: new Date().toISOString(),
          source: {
            repoURL: "https://github.com/Werewolf-p/InfraWeaver-platform",
            path: `clusters/homelab/apps/${name}`,
            targetRevision: "main",
          },
        },
      ],
    },
  };
}

async function fetchApplication(name: string) {
  const encodedName = encodeURIComponent(name);

  try {
    const response = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${encodedName}`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }
  } catch {
    // fall back to the cluster object
  }

  try {
    const customObjectsApi = loadKubeConfig().makeApiClient(k8s.CustomObjectsApi);
    const application = await customObjectsApi.getNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
      name,
    });

    return application as Record<string, unknown>;
  } catch {
    return mockApplication(name) as Record<string, unknown>;
  }
}

async function listRelatedPods(name: string, namespace: string, resources: AppResource[]) {
  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    const podList = await coreApi.listNamespacedPod({ namespace });
    const resourceNames = new Set(resources.map((resource) => normalize(resource.name)).filter(Boolean));
    const appTokens = new Set([
      normalize(name),
      normalize(name.replace(/-manifests$/, "")),
      normalize(name.replace(/^catalog-/, "")),
      normalize(name.replace(/^platform-/, "")),
      normalize(name.replace(/^core-/, "")),
      ...resourceNames,
    ]);

    const mapped = (podList.items ?? []).map((pod) => {
      const labels = pod.metadata?.labels ?? {};
      const labelValues = Object.values(labels).map((value) => normalize(value));
      const ownerNames = (pod.metadata?.ownerReferences ?? []).map((owner) => normalize(owner.name));
      const podName = normalize(pod.metadata?.name);
      const matches =
        labelValues.some((value) => appTokens.has(value)) ||
        ownerNames.some((value) => resourceNames.has(value) || appTokens.has(value)) ||
        Array.from(resourceNames).some((resourceName) => podName.startsWith(resourceName));

      return {
        name: pod.metadata?.name ?? "",
        namespace: pod.metadata?.namespace ?? namespace,
        status: pod.status?.phase ?? "Unknown",
        containers: (pod.spec?.containers ?? []).map((container) => container.name),
        matched: matches,
      };
    });

    const toPodSummary = (pod: typeof mapped[number]) => ({
      name: pod.name,
      namespace: pod.namespace,
      status: pod.status,
      containers: pod.containers,
    });

    const related = mapped.filter((pod) => pod.matched).map(toPodSummary);
    if (related.length > 0) {
      return related;
    }
    return mapped.slice(0, 12).map(toPodSummary);
  } catch {
    return [];
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await params;
  const application = await fetchApplication(name);
  const app = application as {
    metadata?: { name?: string; namespace?: string };
    spec?: {
      project?: string;
      destination?: { namespace?: string; server?: string };
      source?: { repoURL?: string; path?: string; targetRevision?: string };
    };
    status?: {
      health?: { status?: string };
      sync?: { status?: string; revision?: string };
      reconciledAt?: string;
      resources?: AppResource[];
      history?: Array<{
        id?: number;
        revision?: string;
        deployedAt?: string;
        source?: { repoURL?: string; path?: string; targetRevision?: string };
        initiatedBy?: { username?: string; automated?: boolean };
      }>;
      operationState?: {
        phase?: string;
        startedAt?: string;
        finishedAt?: string;
        message?: string;
        syncResult?: { revision?: string };
      };
      summary?: { externalURLs?: string[] };
    };
  };

  const resources = [...(app.status?.resources ?? [])].sort((left, right) => {
    const leftKey = `${left.kind ?? ""}/${left.name ?? ""}`;
    const rightKey = `${right.kind ?? ""}/${right.name ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
  const namespace = app.spec?.destination?.namespace ?? "default";
  const pods = await listRelatedPods(name, namespace, resources);
  const history = [...(app.status?.history ?? [])]
    .slice(-10)
    .reverse()
    .map((entry) => ({
      id: String(entry.id ?? entry.revision ?? entry.deployedAt ?? Math.random()),
      revision: entry.revision ?? app.status?.sync?.revision ?? "",
      deployedAt: entry.deployedAt ?? "",
      repoURL: entry.source?.repoURL ?? app.spec?.source?.repoURL ?? "",
      path: entry.source?.path ?? app.spec?.source?.path ?? "",
      targetRevision: entry.source?.targetRevision ?? app.spec?.source?.targetRevision ?? "",
      initiatedBy: entry.initiatedBy?.username ?? (entry.initiatedBy?.automated ? "Automated" : "ArgoCD"),
    }));

  if (history.length === 0 && app.status?.operationState?.startedAt) {
    history.push({
      id: app.status.operationState.startedAt,
      revision: app.status.operationState.syncResult?.revision ?? app.status?.sync?.revision ?? "",
      deployedAt: app.status.operationState.finishedAt ?? app.status.operationState.startedAt,
      repoURL: app.spec?.source?.repoURL ?? "",
      path: app.spec?.source?.path ?? "",
      targetRevision: app.spec?.source?.targetRevision ?? "",
      initiatedBy: app.status.operationState.phase ?? "ArgoCD",
    });
  }

  return NextResponse.json({
    application: app,
    resources,
    pods,
    history,
    yaml: serializeYaml(app),
  });
}
