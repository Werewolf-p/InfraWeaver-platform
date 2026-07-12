import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { canAccessLogsTarget, clampIntParam, fetchPodLogText, getGameHubAccessContext } from "@/lib/logs-access";
import { kubeUnavailableLogsResponse } from "@/lib/logs-route-helpers";
import { makeCoreApi } from "@/lib/kube-client";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";

const LINES_DEFAULT = 500;
const LINES_MIN = 1;
const LINES_MAX = 1000;

export const GET = withAuth(
  { permission: "apps:read", rateLimit: { name: "logs-read", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
    const namespace = req.nextUrl.searchParams.get("namespace")?.trim() ?? "";
    let pod = req.nextUrl.searchParams.get("pod")?.trim() ?? "";
    let container = req.nextUrl.searchParams.get("container")?.trim() ?? "";
    if (!isValidNamespace(namespace) || (pod && !isValidK8sName(pod)) || (container && !isValidContainerName(container))) {
      return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
    }

    // Needed BEFORE the per-target gate: when no pod is named we pick the first
    // pod the caller may actually access, so the raw context is used directly.
    const gameHubAccess = await getGameHubAccessContext(session, 60);

    const lineParam = req.nextUrl.searchParams.get("lines") ?? req.nextUrl.searchParams.get("tail");
    const lines = clampIntParam(lineParam, LINES_DEFAULT, LINES_MIN, LINES_MAX);

    try {
      const coreApi = makeCoreApi(getRequestClusterId(req));

      if (!pod) {
        const pods = await coreApi.listNamespacedPod({ namespace });
        const candidate = (pods.items ?? [])
          .filter((item) => item.metadata?.name && (item.spec?.containers?.length ?? 0) > 0)
          .sort((left, right) => {
            const leftRunning = left.status?.phase === "Running" ? 0 : 1;
            const rightRunning = right.status?.phase === "Running" ? 0 : 1;
            if (leftRunning !== rightRunning) return leftRunning - rightRunning;
            return (left.metadata?.name ?? "").localeCompare(right.metadata?.name ?? "");
          })
          .find((item) => canAccessLogsTarget(gameHubAccess.groups,
            gameHubAccess.username,
            gameHubAccess.roleAssignments,
            namespace,
            item.metadata?.name ?? "",
          ));

        if (!candidate?.metadata?.name) {
          return NextResponse.json({ error: `No accessible pods with containers found in namespace '${namespace}'` }, { status: 404 });
        }

        pod = candidate.metadata.name;
        container = candidate.spec?.containers?.[0]?.name ?? "";
      } else if (!canAccessLogsTarget(gameHubAccess.groups, gameHubAccess.username, gameHubAccess.roleAssignments, namespace, pod)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      if (!container) {
        const podResource = await coreApi.readNamespacedPod({ name: pod, namespace });
        container = podResource.spec?.containers?.[0]?.name ?? "";
      }

      if (!pod || !container || !isValidK8sName(pod) || !isValidContainerName(container)) {
        return NextResponse.json({ error: "No container found for the requested pod" }, { status: 404 });
      }

      const logText = await fetchPodLogText(coreApi, { namespace, pod, container, tailLines: lines, timestamps: true });
      return new NextResponse(logText, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-InfraWeaver-Log-Pod": pod,
          "X-InfraWeaver-Log-Container": container,
        },
      });
    } catch {
      return kubeUnavailableLogsResponse();
    }
  },
);
