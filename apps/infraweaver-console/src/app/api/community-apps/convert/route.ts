/**
 * POST /api/community-apps/convert
 *
 * Converts an AppFeed app entry to Kubernetes YAML manifests.
 * Returns the generated YAML as a preview — does NOT commit anything.
 * Use /api/community-apps/deploy to commit.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import { convertAppFeedEntry } from "@/lib/appfeed-converter";
import { findAppByIdentifier } from "@/lib/appfeed-cache";
import { safeError } from "@/lib/utils";

const ConvertBody = z.object({
  // App can be passed by name or slug (looked up from feed)
  appName: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
  userVariables: z.record(z.string(), z.string().max(4096)).optional(),
}).refine((value) => Boolean(value.appName?.trim() || value.slug?.trim()), {
  message: "appName or slug is required",
  path: ["appName"],
});

async function findAppInFeed(identifier: string) {
  return findAppByIdentifier(identifier);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("community-convert", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ConvertBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { appName, slug, namespace, pvcSizeGi, storageClass, ingressHost, createIngress, userVariables } = parsed.data;
  const appIdentifier = appName?.trim() || slug?.trim() || "";

  const app = await findAppInFeed(appIdentifier);
  if (!app) {
    return NextResponse.json({ error: `App "${appIdentifier}" not found in AppFeed` }, { status: 404 });
  }

  try {
    const result = convertAppFeedEntry(app, {
      namespace,
      pvcSizeGi,
      storageClass: storageClass?.trim() || undefined,
      ingressHost: ingressHost?.trim() || undefined,
      createIngress,
      userVariables,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error) },
      { status: 422 }
    );
  }
}
