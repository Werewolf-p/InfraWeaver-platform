import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { createMockPodLogStreamResponse, createPodLogStreamResponse } from "@/lib/pod-log-stream";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(rateLimitKey("logs-stream", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const namespace = req.nextUrl.searchParams.get("namespace") ?? "";
  const pod = req.nextUrl.searchParams.get("pod") ?? "";
  const container = req.nextUrl.searchParams.get("container") ?? "";
  if (!namespace || !pod || !container) {
    return NextResponse.json({ error: "namespace, pod, container required" }, { status: 400 });
  }
  if (!isValidNamespace(namespace) || !isValidK8sName(pod) || !isValidContainerName(container)) {
    return NextResponse.json({ error: "Invalid resource name" }, { status: 400 });
  }

  const access = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(access.groups, access.username, access.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return createPodLogStreamResponse(namespace, pod, container, req.signal);
  } catch {
    return createMockPodLogStreamResponse();
  }
}
