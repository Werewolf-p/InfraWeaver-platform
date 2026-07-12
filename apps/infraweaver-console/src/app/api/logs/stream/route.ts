import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { requireLogsTargetAccess } from "@/lib/logs-route-helpers";
import { createPodLogStreamResponse } from "@/lib/pod-log-stream";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { unavailableResponse } from "@/lib/route-utils";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";

// Hand-rolled guard (not withAuth): the success path returns a plain SSE
// `Response`, which the withAuth envelope would wrap in NextResponse.json.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "apps:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const targetAccess = await requireLogsTargetAccess(session, namespace, pod);
  if (targetAccess instanceof NextResponse) return targetAccess;

  try {
    return createPodLogStreamResponse(namespace, pod, container, req.signal);
  } catch (error) {
    // Fail closed — never fabricate a mock log stream when Kubernetes is
    // unreachable; surface the canonical 503 instead.
    return unavailableResponse(error);
  }
}
