import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { getRegistryConfig, listTags } from "@/lib/registry";

const SAFE_REPO_RE = /^[a-z0-9][a-z0-9/_.-]*$/;

export const GET = withAuth<{ repo: string }>(
  { permission: "config:read" },
  async ({ params }) => {
    const repo = decodeURIComponent(params.repo);
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
  },
);
