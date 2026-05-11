/**
 * POST /api/community-apps/convert
 *
 * Converts an AppFeed app entry to Kubernetes YAML manifests.
 * Returns the generated YAML as a preview — does NOT commit anything.
 * Use /api/community-apps/deploy to commit.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import { convertAppFeedEntry, type AppFeedEntry } from "@/lib/appfeed-converter";

const APPFEED_URL = "https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json";

const ConvertBody = z.object({
  // App can be passed by name (looked up from feed) or as full entry (from client cache)
  appName: z.string().min(1).max(200),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
});

async function findAppInFeed(name: string): Promise<AppFeedEntry | null> {
  const res = await fetch(APPFEED_URL, {
    next: { revalidate: 7200 },
    headers: { "User-Agent": "InfraWeaver-Console/1.0" },
  });
  if (!res.ok) return null;

  const feed = await res.json() as { applist: AppFeedEntry[] };
  const lower = name.toLowerCase();
  return feed.applist.find(
    a => typeof a.Name === "string" && a.Name.toLowerCase() === lower
  ) ?? null;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("community-convert", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ConvertBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { appName, namespace, pvcSizeGi, storageClass, ingressHost, createIngress } = parsed.data;

  const app = await findAppInFeed(appName);
  if (!app) {
    return NextResponse.json({ error: `App "${appName}" not found in AppFeed` }, { status: 404 });
  }

  const result = convertAppFeedEntry(app, {
    namespace: namespace ?? app.Name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 63),
    pvcSizeGi,
    storageClass,
    ingressHost,
    createIngress,
  });

  return NextResponse.json(result);
}
