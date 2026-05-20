import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { createMockPodLogStreamResponse, createPodLogStreamResponse } from "@/lib/pod-log-stream";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "apps:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("logs-stream", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { namespace, name } = await params;
  const container = req.nextUrl.searchParams.get("container") ?? "";
  if (!container) {
    return NextResponse.json({ error: "container required" }, { status: 400 });
  }
  if (!isValidNamespace(namespace) || !isValidK8sName(name) || !isValidContainerName(container)) {
    return NextResponse.json({ error: "Invalid resource name" }, { status: 400 });
  }

  const gameHubAccess = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(gameHubAccess.groups, gameHubAccess.username, gameHubAccess.roleAssignments, namespace, name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return createPodLogStreamResponse(namespace, name, container, req.signal);
  } catch {
    return createMockPodLogStreamResponse();
  }
}
