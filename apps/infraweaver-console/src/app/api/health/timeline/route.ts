import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!PROMETHEUS_URL) {
    return NextResponse.json({ available: false, error: "Metrics backend not configured. Set PROMETHEUS_URL environment variable." }, { status: 503 });
  }

  try {
    const endMs = Date.now();
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const step = 300; // 5-minute resolution

    const query = encodeURIComponent('up{job="kubernetes-nodes"}');
    const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${query}&start=${Math.floor(startMs / 1000)}&end=${Math.floor(endMs / 1000)}&step=${step}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ available: false, error: `Prometheus returned ${res.status}` }, { status: 503 });
    }

    const data = await res.json() as {
      status: string;
      data?: { result?: Array<{ values?: Array<[number, string]> }> };
    };

    if (data.status !== "success") {
      return NextResponse.json({ available: false, error: "Prometheus query failed" }, { status: 503 });
    }

    const allValues = (data.data?.result ?? []).flatMap(r => r.values ?? []);
    const byTimestamp = new Map<number, number[]>();
    for (const [ts, val] of allValues) {
      const bucket = Math.floor(ts / step) * step;
      if (!byTimestamp.has(bucket)) byTimestamp.set(bucket, []);
      byTimestamp.get(bucket)!.push(Number(val));
    }

    const points = Array.from(byTimestamp.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, vals]) => {
        const downCount = vals.filter(v => v === 0).length;
        const status = downCount === 0 ? "up" : downCount === vals.length ? "down" : "degraded";
        return { timestamp: new Date(ts * 1000).toISOString(), status, latencyMs: 0 };
      });

    return NextResponse.json({ available: true, data: points });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ available: false, error: `Prometheus unreachable: ${msg}` }, { status: 503 });
  }
}
