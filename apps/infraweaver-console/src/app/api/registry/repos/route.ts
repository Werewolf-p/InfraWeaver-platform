import { NextResponse } from "next/server";

const REGISTRY_HOST = process.env.REGISTRY_HOST ?? "registry.int.rlservers.com";
const REGISTRY_USERNAME = process.env.REGISTRY_USERNAME ?? "";
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD ?? "";

function getAuthHeader(): Record<string, string> {
  if (!REGISTRY_USERNAME || !REGISTRY_PASSWORD) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD}`).toString("base64")}`,
  };
}

export async function GET() {
  try {
    const res = await fetch(`https://${REGISTRY_HOST}/v2/_catalog`, {
      headers: { ...getAuthHeader(), Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    const data = await res.json() as { repositories: string[] };
    return NextResponse.json({ repositories: data.repositories ?? [] });
  } catch {
    return NextResponse.json({
      repositories: ["infraweaver/console", "infraweaver/api", "homelab/nginx", "homelab/postgres"],
      mock: true,
    });
  }
}
