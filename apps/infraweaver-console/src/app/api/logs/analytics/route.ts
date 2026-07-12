import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { fetchPodLogText } from "@/lib/logs-access";
import { requireLogsTargetAccess } from "@/lib/logs-route-helpers";
import { makeCoreApi } from "@/lib/kube-client";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";

function parseLevel(line: string): string {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("err ")) return "error";
  if (l.includes("warn")) return "warn";
  if (l.includes("debug")) return "debug";
  return "info";
}

export const GET = withAuth(
  { permission: "apps:read", rateLimit: { name: "logs-read", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
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
    const access = await requireLogsTargetAccess(session, namespace, pod);
    if (access instanceof NextResponse) return access;

    try {
      const coreApi = makeCoreApi(getRequestClusterId(req));
      const logText = await fetchPodLogText(coreApi, { namespace, pod, container, tailLines: 500 });
      const lines = logText.split("\n").filter(Boolean);
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
  },
);
