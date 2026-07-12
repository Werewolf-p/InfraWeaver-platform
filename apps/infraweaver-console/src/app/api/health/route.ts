import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiCache } from "@/lib/api-cache";
import { getClusterConfig, getRequestClusterId } from "@/lib/cluster-context";
import { fetchGatusStatuses } from "@/lib/gatus";

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
    // Strip results down to { success } so anonymous-visible payloads stay lean.
    const endpoints = (await fetchGatusStatuses({ baseUrl: gatusBase, timeoutMs: 5000 })).map((endpoint) => ({
      name: endpoint.name,
      group: endpoint.group,
      results: endpoint.results.map((result) => ({ success: result.success })),
    }));
    const degraded = endpoints.filter((endpoint) => endpoint.results.some((result) => !result.success)).length;
    snapshot = { available: true, status: degraded > 0 ? "degraded" : "ok", endpoints };
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
