import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { getRegistryConfig, listTags } from "@/lib/registry";

// Each slash-separated segment must be a plain name — no '.'/'..' path
// segments, so a crafted repo can never escape the configured project path.
const SAFE_REPO_SEGMENT_RE = /^[a-z0-9][a-z0-9_.-]*$/;

function isValidRepoName(repo: string): boolean {
  const segments = repo.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "." && segment !== ".." && SAFE_REPO_SEGMENT_RE.test(segment))
  );
}

export const GET = withAuth<{ repo: string }>(
  { permission: "config:read" },
  async ({ params }) => {
    const repo = decodeURIComponent(params.repo);
    if (!isValidRepoName(repo)) {
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
