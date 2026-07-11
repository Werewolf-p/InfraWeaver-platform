import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/logs-access";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

function parseLevel(line: string): string {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("err ")) return "error";
  if (l.includes("warn")) return "warn";
  if (l.includes("debug")) return "debug";
  return "info";
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "apps:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("logs-read", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = req.nextUrl;
  const namespace = searchParams.get("namespace") ?? "default";
  const pod = searchParams.get("pod") ?? "";
  const container = searchParams.get("container") ?? undefined;
  if (!isValidNamespace(namespace) || !isValidK8sName(pod) || (container !== undefined && !isValidContainerName(container))) {
    return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
  }

  // Per-pod log-access scoping (mirrors the sibling container-log route): a holder
  // of apps:read that lacks cluster:read/infra:read may only read logs of pods they
  // are granted (e.g. their game-hub servers) — never arbitrary namespaces such as
  // authentik or openbao. Without this the endpoint is a BOLA.
  const gameHubAccess = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(gameHubAccess.groups, gameHubAccess.username, gameHubAccess.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.readNamespacedPodLog({ name: pod, namespace, container, tailLines: 500 });
    const lines = (res as string).split("\n").filter(Boolean);
    const levels: Record<string, number> = { error: 0, warn: 0, info: 0, debug: 0 };
    const topErrors: string[] = [];
    for (const line of lines) {
      const level = parseLevel(line);
      levels[level]++;
      if (level === "error" && topErrors.length < 10) topErrors.push(line.slice(0, 200));
    }
    return NextResponse.json({ levels, topErrors, totalLines: lines.length });
  } catch {
    // Fail closed — never fabricate analytics (the previous mock fallback masked
    // both outages and the 403 above).
    return NextResponse.json({ error: "Failed to read pod logs", available: false }, { status: 502 });
  }
}
