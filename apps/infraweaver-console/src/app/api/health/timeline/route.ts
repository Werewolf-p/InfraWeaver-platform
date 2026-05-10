import { NextResponse } from "next/server";

export async function GET() {
  const now = Date.now();
  const points = Array.from({ length: 288 }, (_, i) => {
    const ts = new Date(now - (287 - i) * 5 * 60 * 1000).toISOString();
    const rand = Math.random();
    const status = rand > 0.05 ? "up" : rand > 0.02 ? "degraded" : "down";
    const latencyMs = status === "up" ? 50 + Math.random() * 100 : status === "degraded" ? 300 + Math.random() * 500 : 0;
    return { timestamp: ts, status, latencyMs: Math.round(latencyMs) };
  });
  return NextResponse.json({ data: points });
}
