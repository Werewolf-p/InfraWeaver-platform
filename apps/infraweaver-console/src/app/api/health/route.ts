import { NextRequest, NextResponse } from "next/server";
import { getClusterConfig, getRequestClusterId } from "@/lib/cluster-context";

// NOTE: This endpoint is intentionally public — used as the k8s liveness/readiness probe.
// Sensitive health data (timeline, cluster status) is protected on separate authenticated routes.
export async function GET(request: NextRequest) {
  const clusterId = getRequestClusterId(request);
  const clusterConfig = getClusterConfig(clusterId);
  const gatusBase = clusterConfig?.gatusUrl ?? process.env.GATUS_URL ?? "http://gatus.gatus.svc.cluster.local:8080";

  try {
    const res = await fetch(`${gatusBase}/api/v1/endpoints/statuses?page=1&pageSize=100`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ endpoints: [], available: false, error: `Gatus returned ${res.status}` }, { status: 503 });

    const raw = await res.json() as unknown;

    // Gatus v5 returns the list directly as an array;
    // Gatus v5.7+ may return a paginated { results: [...], total: N } object.
    const items: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { results?: unknown[] }).results)
        ? (raw as { results: unknown[] }).results
        : [];

    // Normalize each endpoint so we always have { name, results: [{ success }] }
    const endpoints = items.map((item) => {
      const ep = item as {
        name?: string;
        group?: string;
        results?: Array<{ success?: boolean; conditionResults?: Array<{ success: boolean }> }>;
      };
      const results = (ep.results ?? []).map((r) => ({
        success: typeof r.success === "boolean"
          ? r.success
          : (r.conditionResults ?? []).every((c) => c.success),
      }));
      return { name: ep.name ?? "Unknown", group: ep.group ?? "", results };
    });

    return NextResponse.json({ endpoints, available: true });
  } catch {
    return NextResponse.json({ endpoints: [], available: false, error: "Gatus unreachable" }, { status: 503 });
  }
}
