import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(rateLimitKey("logs-read", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const namespace = req.nextUrl.searchParams.get("namespace")?.trim() ?? "";
  let pod = req.nextUrl.searchParams.get("pod")?.trim() ?? "";
  let container = req.nextUrl.searchParams.get("container")?.trim() ?? "";
  if (!isValidNamespace(namespace) || (pod && !isValidK8sName(pod)) || (container && !isValidContainerName(container))) {
    return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
  }

  const access = await getGameHubAccessContext(session, 60);
  const lineParam = req.nextUrl.searchParams.get("lines") ?? req.nextUrl.searchParams.get("tail") ?? "500";
  const lines = Math.min(Math.max(parseInt(lineParam, 10) || 500, 1), 1000);

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);

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
        .find((item) => canAccessLogsTarget(
          access.groups,
          access.username,
          access.roleAssignments,
          namespace,
          item.metadata?.name ?? "",
        ));

      if (!candidate?.metadata?.name) {
        return NextResponse.json({ error: `No accessible pods with containers found in namespace '${namespace}'` }, { status: 404 });
      }

      pod = candidate.metadata.name;
      container = candidate.spec?.containers?.[0]?.name ?? "";
    } else if (!canAccessLogsTarget(access.groups, access.username, access.roleAssignments, namespace, pod)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!container) {
      const podResource = await coreApi.readNamespacedPod({ name: pod, namespace });
      container = podResource.spec?.containers?.[0]?.name ?? "";
    }

    if (!pod || !container || !isValidK8sName(pod) || !isValidContainerName(container)) {
      return NextResponse.json({ error: "No container found for the requested pod" }, { status: 404 });
    }

    const logRes = await coreApi.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines: lines,
      timestamps: true,
    });
    return new NextResponse(logRes as string, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-InfraWeaver-Log-Pod": pod,
        "X-InfraWeaver-Log-Container": container,
      },
    });
  } catch {
    return new NextResponse("Kubernetes unavailable — cannot retrieve logs", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
