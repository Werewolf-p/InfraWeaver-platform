import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { getRegistryConfig, getManifestDigest, deleteManifest } from "@/lib/registry";

// Registry repo paths may contain slashes (e.g. "infraweaver/console")
const SAFE_REPO_RE = /^[a-z0-9][a-z0-9/_.-]*$/;
// Tag names allow alphanumeric, dots, dashes, underscores
const SAFE_TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ repo: string; tag: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const cfg = getRegistryConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "Registry not configured" }, { status: 503 });
  }

  try {
    const digest = await getManifestDigest(cfg, repo, tag);
    if (!digest) throw new Error("No digest found");
    const ok = await deleteManifest(cfg, repo, digest);
    if (!ok) throw new Error("Delete failed");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
