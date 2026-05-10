import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const urlParam = req.nextUrl.searchParams.get("urls") ?? "";
  const urls = urlParam.split(",").map(u => u.trim()).filter(Boolean);

  if (urls.length === 0) {
    return NextResponse.json({ results: {} });
  }

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        });
        const latencyMs = Date.now() - start;
        return { url, ok: res.ok, latencyMs };
      } catch {
        return { url, ok: false, latencyMs: Date.now() - start };
      }
    })
  );

  const output: Record<string, { ok: boolean; latencyMs: number }> = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      output[result.value.url] = { ok: result.value.ok, latencyMs: result.value.latencyMs };
    }
  }

  return NextResponse.json({ results: output });
}
