import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { clampIntParam, fetchPodLogText } from "@/lib/logs-access";
import { kubeUnavailableLogsResponse, requireLogsTargetAccess } from "@/lib/logs-route-helpers";
import { makeCoreApi } from "@/lib/kube-client";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth<{ namespace: string; pod: string; container: string }>(
  { permission: "apps:read", rateLimit: { name: "logs-read", limit: 30, windowMs: 60_000 } },
  async ({ req, session, params }) => {
    const { namespace, pod, container } = params;
    if (!isValidNamespace(namespace) || !isValidK8sName(pod) || !isValidContainerName(container)) {
      return NextResponse.json({ error: "Invalid name: only lowercase alphanumeric and dashes allowed" }, { status: 400 });
    }

    const access = await requireLogsTargetAccess(session, namespace, pod);
    if (access instanceof NextResponse) return access;

    const lines = clampIntParam(req.nextUrl.searchParams.get("lines"), 500, 1, 1000);

    try {
      const coreApi = makeCoreApi(getRequestClusterId(req));
      const logText = await fetchPodLogText(coreApi, { namespace, pod, container, tailLines: lines, timestamps: true });
      return new NextResponse(logText, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch {
      return kubeUnavailableLogsResponse();
    }
  },
);
