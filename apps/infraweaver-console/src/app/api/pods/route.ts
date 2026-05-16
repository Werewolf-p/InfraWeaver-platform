import { NextRequest, NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { auth } from "@/lib/auth";
import { loadKubeConfig } from "@/lib/k8s";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";

interface PodListItem {
  containers: string[];
  createdAt: string;
  name: string;
  namespace: string;
  nodeName: string;
  restartCount: number;
  status: string;
}

interface PaginatedPodsResponse {
  page: number;
  pages: number;
  pods: PodListItem[];
  total: number;
}

function normalizeNamespace(namespace: string | null) {
  return namespace && namespace !== "all" ? namespace : undefined;
}

function mapPod(pod: k8s.V1Pod): PodListItem {
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const waitingReason = containerStatuses.find((status) => status.state?.waiting?.reason)?.state?.waiting?.reason ?? "";
  return {
    name: pod.metadata?.name ?? "",
    namespace: pod.metadata?.namespace ?? "",
    status: waitingReason || pod.status?.phase || "Unknown",
    containers: (pod.spec?.containers ?? []).map((container) => container.name),
    nodeName: pod.spec?.nodeName ?? "",
    createdAt: pod.metadata?.creationTimestamp?.toISOString() ?? "",
    restartCount: containerStatuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
  };
}

async function listPodChunk(coreApi: k8s.CoreV1Api, namespace: string | undefined, limit: number, continueToken?: string) {
  if (namespace) {
    return coreApi.listNamespacedPod({ namespace, limit, _continue: continueToken });
  }
  return coreApi.listPodForAllNamespaces({ limit, _continue: continueToken });
}

async function listAllPods(coreApi: k8s.CoreV1Api, namespace: string | undefined) {
  const pods: PodListItem[] = [];
  let continueToken: string | undefined;

  do {
    const response = await listPodChunk(coreApi, namespace, 500, continueToken);
    pods.push(...response.items.map(mapPod));
    continueToken = response.metadata?._continue || undefined;
  } while (continueToken);

  return pods;
}

async function listPaginatedPods(coreApi: k8s.CoreV1Api, namespace: string | undefined, page: number, limit: number): Promise<PaginatedPodsResponse> {
  const offset = (page - 1) * limit;
  const batchSize = Math.min(500, Math.max(limit, 100));
  const pods: PodListItem[] = [];
  let continueToken: string | undefined;
  let total = 0;

  do {
    const response = await listPodChunk(coreApi, namespace, batchSize, continueToken);
    const items = response.items;
    const sliceStart = Math.max(0, offset - total);
    const sliceEnd = Math.min(items.length, offset + limit - total);
    if (sliceStart < sliceEnd) {
      pods.push(...items.slice(sliceStart, sliceEnd).map(mapPod));
    }
    total += items.length;
    continueToken = response.metadata?._continue || undefined;
  } while (continueToken);

  return {
    pods,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}


export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const namespace = normalizeNamespace(req.nextUrl.searchParams.get("namespace"));
  const pageParam = req.nextUrl.searchParams.get("page");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const isPaginated = pageParam !== null || limitParam !== null;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const limit = Math.min(500, Math.max(1, Number.parseInt(limitParam ?? "50", 10) || 50));

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    if (isPaginated) {
      return NextResponse.json(await listPaginatedPods(coreApi, namespace, page, limit));
    }
    return NextResponse.json(await listAllPods(coreApi, namespace));
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
}
