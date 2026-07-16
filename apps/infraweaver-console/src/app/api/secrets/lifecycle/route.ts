import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { collectSecretLifecycle } from "@/lib/secrets/lifecycle-collector";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";

/**
 * GET /api/secrets/lifecycle — the single Secret & GitOps lifecycle collector.
 * Returns a `SecretLifecycleReport`. Per-section `available:false` on partial
 * backend failure; 503 only when the whole collector throws (it normally won't —
 * every collector degrades internally).
 */
export const GET = withRoute("security:read", async (req) => {
  try {
    const report = await collectSecretLifecycle(getRequestClusterId(req));
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ available: false, error: safeError(err) }, { status: 503 });
  }
});
