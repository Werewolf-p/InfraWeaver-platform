import { NextRequest, NextResponse } from "next/server";

const DEFAULT_ALLOWED_DOMAINS = ["rlservers.com", "int.rlservers.com"];

function getAllowedDomains(): string[] {
  return (process.env.ALLOWED_PING_DOMAINS ?? DEFAULT_ALLOWED_DOMAINS.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isRawIp(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^[a-f0-9:]+$/i.test(hostname);
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || isRawIp(hostname) || hostname === "localhost") return false;
    return getAllowedDomains().some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get("urls") ?? "";
  const urls = urlParam.split(",").map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0) return NextResponse.json({ results: {} });

  const results = await Promise.all(
    urls.map(async (url) => {
      if (!isAllowedUrl(url)) {
        return { url, ok: false, latencyMs: 0, error: "blocked" };
      }

      const start = Date.now();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        });
        return { url, ok: res.ok, latencyMs: Date.now() - start };
      } catch {
        return { url, ok: false, latencyMs: Date.now() - start };
      }
    })
  );

  const output: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
  for (const result of results) {
    output[result.url] = result.error
      ? { ok: result.ok, latencyMs: result.latencyMs, error: result.error }
      : { ok: result.ok, latencyMs: result.latencyMs };
  }

  return NextResponse.json({ results: output });
}
