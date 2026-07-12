import { NextResponse } from "next/server";
import { isPrometheusConfigured, promQueryRange } from "@/lib/prometheus";
import { unavailableResponse } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "cluster:read" }, async () => {
  if (!isPrometheusConfigured()) {
    return NextResponse.json({ available: false, error: "Metrics backend not configured. Set PROMETHEUS_URL environment variable." }, { status: 503 });
  }

  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 24 * 60 * 60;
    const step = 300; // 5-minute resolution

    const series = await promQueryRange('up{job="kubernetes-nodes"}', { start, end, step, timeoutMs: 5000 });

    const allValues = series.flatMap(r => r.values ?? []);
    const byTimestamp = new Map<number, number[]>();
    for (const [ts, val] of allValues) {
      const bucket = Math.floor(Number(ts) / step) * step;
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
    return unavailableResponse(err);
  }
});
