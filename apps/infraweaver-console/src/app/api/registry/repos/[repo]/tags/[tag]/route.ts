import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";

const REGISTRY_HOST = process.env.REGISTRY_HOST ?? "registry.int.rlservers.com";
const REGISTRY_USERNAME = process.env.REGISTRY_USERNAME ?? "";
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD ?? "";

function getAuthHeader(): Record<string, string> {
  if (!REGISTRY_USERNAME || !REGISTRY_PASSWORD) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD}`).toString("base64")}`,
  };
}

// Registry repo paths may contain slashes (e.g. "infraweaver/console")
const SAFE_REPO_RE = /^[a-z0-9][a-z0-9/_-]*$/;
// Tag names allow alphanumeric, dots, dashes, underscores
const SAFE_TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ repo: string; tag: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("registry-delete", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { repo: encodedRepo, tag } = await params;
  const repo = decodeURIComponent(encodedRepo);

  if (!SAFE_REPO_RE.test(repo)) {
    return NextResponse.json({ error: "Invalid repo name" }, { status: 400 });
  }
  if (!SAFE_TAG_RE.test(tag)) {
    return NextResponse.json({ error: "Invalid tag name" }, { status: 400 });
  }

  try {
    const manifestRes = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/manifests/${tag}`, {
      headers: {
        ...getAuthHeader(),
        Accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!manifestRes.ok) throw new Error(`Failed to get manifest: ${manifestRes.status}`);
    const digest = manifestRes.headers.get("Docker-Content-Digest");
    if (!digest) throw new Error("No digest found");
    const deleteRes = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/manifests/${digest}`, {
      method: "DELETE",
      headers: { ...getAuthHeader() },
      signal: AbortSignal.timeout(5000),
    });
    if (!deleteRes.ok && deleteRes.status !== 202) {
      throw new Error(`Delete failed: ${deleteRes.status}`);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
