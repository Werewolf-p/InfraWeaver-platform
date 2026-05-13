/**
 * GET /api/community-apps
 *
 * Returns paginated apps from the Unraid Community Applications AppFeed.
 * The feed (~33MB) is cached in Node.js memory for 2 hours via appfeed-cache.ts
 * (Next.js fetch cache cannot handle responses >2MB).
 *
 * Query params:
 *   page     — page number (default: 1)
 *   limit    — apps per page (default: 24, max: 100)
 *   search   — text search across name + overview
 *   category — filter by CategoryList value (e.g. "MediaApp:Video")
 *   tier     — "simple" | "medium" | "complex"
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { summarizeApp, detectTier, type AppFeedEntry } from "@/lib/appfeed-converter";
import { getAppFeed } from "@/lib/appfeed-cache";
import { safeError } from "@/lib/utils";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "24", 10)));
  const search = (searchParams.get("search") ?? "").toLowerCase().trim();
  const categoryFilter = searchParams.get("category") ?? "";
  const tierFilter = searchParams.get("tier") ?? "";

  try {
    const feed = await getAppFeed();

    // Filter to valid apps (must have Name + Repository)
    let apps = feed.applist.filter(
      (a): a is AppFeedEntry => typeof a.Name === "string" && typeof a.Repository === "string"
    );

    // Apply filters
    if (search) {
      apps = apps.filter(a =>
        a.Name.toLowerCase().includes(search) ||
        (a.Overview ?? "").toLowerCase().includes(search) ||
        a.Repository.toLowerCase().includes(search)
      );
    }

    if (categoryFilter) {
      apps = apps.filter(a =>
        (a.CategoryList ?? []).some((cat: string) =>
          cat.toLowerCase().includes(categoryFilter.toLowerCase())
        )
      );
    }

    if (tierFilter && ["simple", "medium", "complex"].includes(tierFilter)) {
      apps = apps.filter(a => detectTier(a) === tierFilter);
    }

    // Sort: official first, then by stars desc
    apps.sort((a, b) => {
      const bStars = b.stars ?? 0;
      const aStars = a.stars ?? 0;
      return bStars - aStars;
    });

    const total = apps.length;
    const offset = (page - 1) * limit;
    const pageApps = apps.slice(offset, offset + limit).map(summarizeApp);

    return NextResponse.json(
      {
        apps: pageApps,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        last_updated: feed.last_updated,
        last_updated_timestamp: feed.last_updated_timestamp,
        categories: feed.categories,
      },
      {
        headers: {
          // Tell the browser this is fresh for 5 minutes (server cache is 2h)
          "Cache-Control": "private, max-age=300, stale-while-revalidate=60",
        },
      }
    );
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 502 });
  }
}
