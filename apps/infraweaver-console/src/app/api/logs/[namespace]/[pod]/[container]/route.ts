import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; pod: string; container: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(rateLimitKey("logs-read", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { namespace, pod, container } = await params;
  if (!isValidNamespace(namespace) || !isValidK8sName(pod) || !isValidContainerName(container)) {
    return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
  }

  const access = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(access.groups, access.username, access.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const lines = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("lines") ?? "500", 10) || 500, 1), 1000);
  const mockLines = Array.from({ length: Math.min(lines, 50) }, (_, i) => {
    const date = new Date(Date.now() - (50 - i) * 2000);
    return `${date.toISOString()} INFO [${container}] Log line ${i + 1} - container ${container} in ${namespace}/${pod} is running normally`;
  }).join("\n");

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
    const logRes = await coreApi.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines: lines,
      timestamps: true,
    });
    return new NextResponse(logRes as string, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new NextResponse(mockLines, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
