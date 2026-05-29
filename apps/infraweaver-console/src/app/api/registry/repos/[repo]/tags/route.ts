import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { getRegistryConfig, listTags } from "@/lib/registry";

const SAFE_REPO_RE = /^[a-z0-9][a-z0-9/_.-]*$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ repo: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { repo: encodedRepo } = await params;
  const repo = decodeURIComponent(encodedRepo);
  if (!SAFE_REPO_RE.test(repo)) {
    return NextResponse.json({ error: "Invalid repo name" }, { status: 400 });
  }

  const cfg = getRegistryConfig();
  if (!cfg.configured) {
    return NextResponse.json({ repo, tags: [], error: "Registry not configured" }, { status: 200 });
  }

  try {
    const tags = await listTags(cfg, repo);
    return NextResponse.json({ repo, tags });
  } catch {
    return NextResponse.json({ error: "Registry unavailable" }, { status: 503 });
  }
}
