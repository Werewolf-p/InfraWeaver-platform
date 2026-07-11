import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiCache } from "@/lib/api-cache";
import { getClusterConfig, getRequestClusterId } from "@/lib/cluster-context";

// This endpoint is public and rate-limit exempt (see src/proxy.ts), so the
// Gatus fetch is cached briefly — anonymous probes must never translate 1:1
// into upstream requests (amplification / Gatus DoS lever).
const HEALTH_CACHE_TTL_MS = 10_000;

interface HealthEndpoint {
  name: string;
  group: string;
  results: Array<{ success: boolean }>;
}

interface HealthSnapshot {
  available: boolean;
  status: "ok" | "degraded";
  endpoints: HealthEndpoint[];
}

async function fetchHealthSnapshot(gatusBase: string): Promise<HealthSnapshot> {
  const cacheKey = `health:gatus:${gatusBase}`;
  const cached = apiCache.get<HealthSnapshot>(cacheKey);
  if (cached) return cached;

  let snapshot: HealthSnapshot;
  try {
    const res = await fetch(`${gatusBase}/api/v1/endpoints/statuses?page=1&pageSize=100`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      snapshot = { available: false, status: "degraded", endpoints: [] };
    } else {
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

      const degraded = endpoints.filter((endpoint) => endpoint.results.some((result) => !result.success)).length;
      snapshot = { available: true, status: degraded > 0 ? "degraded" : "ok", endpoints };
    }
  } catch {
    snapshot = { available: false, status: "degraded", endpoints: [] };
  }

  // Cache failures too, so a down/slow Gatus cannot be hammered through us.
  apiCache.set(cacheKey, snapshot, HEALTH_CACHE_TTL_MS);
  return snapshot;
}

// NOTE: This endpoint remains probe-friendly for anonymous callers, but only
// returns detailed Gatus endpoint data to authenticated sessions.
export async function GET(request: NextRequest) {
  const clusterId = getRequestClusterId(request);
  const clusterConfig = getClusterConfig(clusterId);
  const gatusBase = clusterConfig?.gatusUrl ?? process.env.GATUS_URL ?? "http://gatus.gatus.svc.cluster.local:8080";

  const { available, status, endpoints } = await fetchHealthSnapshot(gatusBase);
  if (!available) return NextResponse.json({ available: false, status: "degraded" }, { status: 503 });

  const session = await auth();
  if (!session) {
    return NextResponse.json({ available: true, status });
  }

  const degraded = endpoints.filter((endpoint) => endpoint.results.some((result) => !result.success)).length;
  return NextResponse.json({
    available: true,
    status,
    summary: {
      total: endpoints.length,
      degraded,
    },
    endpoints,
  });
}
