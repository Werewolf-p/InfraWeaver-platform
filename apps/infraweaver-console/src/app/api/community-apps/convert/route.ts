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
import { convertAppFeedEntry } from "@/lib/appfeed-converter";
import { findAppByName } from "@/lib/appfeed-cache";

const ConvertBody = z.object({
  // App can be passed by name (looked up from feed) or as full entry (from client cache)
  appName: z.string().min(1).max(200),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
});

async function findAppInFeed(name: string) {
  return findAppByName(name);
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

  try {
    const result = convertAppFeedEntry(app, {
      namespace,
      pvcSizeGi,
      storageClass: storageClass?.trim() || undefined,
      ingressHost: ingressHost?.trim() || undefined,
      createIngress,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Conversion failed" },
      { status: 422 }
    );
  }
}
