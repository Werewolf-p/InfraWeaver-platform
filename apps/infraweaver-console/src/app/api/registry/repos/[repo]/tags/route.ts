import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const REGISTRY_HOST = process.env.REGISTRY_HOST ?? "registry.int.rlservers.com";
const REGISTRY_USERNAME = process.env.REGISTRY_USERNAME ?? "";
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD ?? "";

function getAuthHeader(): Record<string, string> {
  if (!REGISTRY_USERNAME || !REGISTRY_PASSWORD) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD}`).toString("base64")}`,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ repo: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { repo: encodedRepo } = await params;
  const repo = decodeURIComponent(encodedRepo);
  try {
    const res = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/tags/list`, {
      headers: { ...getAuthHeader(), Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    const data = await res.json() as { tags: string[] | null };
    const tags = data.tags ?? [];
    const tagDetails = await Promise.all(
      tags.slice(0, 20).map(async (tag: string) => {
        try {
          const mRes = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/manifests/${tag}`, {
            headers: {
              ...getAuthHeader(),
              Accept: "application/vnd.docker.distribution.manifest.v2+json",
            },
            signal: AbortSignal.timeout(3000),
          });
          const digest = mRes.headers.get("Docker-Content-Digest") ?? "";
          const contentLength = mRes.headers.get("Content-Length");
          let size = contentLength ? parseInt(contentLength) : 0;
          const manifest = await mRes.json().catch(() => ({})) as Record<string, unknown>;
          if ((manifest as { layers?: Array<{ size: number }> })?.layers) {
            size = ((manifest as { layers: Array<{ size: number }> }).layers).reduce((acc, l) => acc + (l.size ?? 0), 0);
          }
          return { tag, digest: digest.slice(0, 19), size, pushedAt: null as string | null };
        } catch {
          return { tag, digest: "", size: 0, pushedAt: null };
        }
      })
    );
    return NextResponse.json({ repo, tags: tagDetails });
  } catch {
    return NextResponse.json({
      repo,
      tags: [
        { tag: "latest", digest: "sha256:abc123def456", size: 45000000, pushedAt: new Date().toISOString() },
        { tag: "v1.0.0", digest: "sha256:def456abc789", size: 43000000, pushedAt: new Date(Date.now() - 86400000).toISOString() },
      ],
      mock: true,
    });
  }
}
