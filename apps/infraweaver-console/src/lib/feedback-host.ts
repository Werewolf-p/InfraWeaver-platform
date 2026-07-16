import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { Permission } from "@/lib/rbac";
import { internalHost } from "@/lib/domain";
import { apiError, requireRoutePermissions } from "@/lib/route-utils";

/**
 * Domain gate for the feedback REVIEW dashboard.
 *
 * The console image is reused verbatim for ephemeral preview deployments, so the
 * same code runs on both the canonical console host and on every preview host.
 * The Approve / Validate / Publish controls (and their mutating + run-log APIs)
 * must only ever be reachable on the canonical host — never inside a preview,
 * where an approval would recursively re-trigger the pipeline.
 *
 * The report/submit button stays available everywhere; only the review surface
 * is gated. Gate is host-based: compare the request Host against
 * FEEDBACK_DASHBOARD_HOST (default `infraweaver.int.<base-domain>`).
 */
const FEEDBACK_DASHBOARD_HOST = process.env.FEEDBACK_DASHBOARD_HOST ?? internalHost("infraweaver");

/** Strip any `:port` and lowercase so `Host: foo:443` matches `foo`. */
function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").split(":")[0].trim().toLowerCase();
}

export function feedbackDashboardHost(): string {
  return normalizeHost(FEEDBACK_DASHBOARD_HOST);
}

/**
 * True when the request targets the canonical console host. Accepts a Headers
 * instance (route handlers) or a plain host string. Derives the host from the
 * `host` header only: `x-forwarded-host` is client-settable and must never be
 * trusted for this canonical-vs-preview security gate.
 */
export function isFeedbackHost(source: Headers | string | null | undefined): boolean {
  const canonical = feedbackDashboardHost();
  if (!canonical) return true; // unset → fail-open (single-host dev)

  let host: string | null | undefined;
  if (typeof source === "string" || source == null) {
    host = source;
  } else {
    host = source.get("host");
  }
  return normalizeHost(host) === canonical;
}

/**
 * Feedback management permission set — approving / dispatching / resolving /
 * publishing feedback is an admin-gated action. Human-in-the-loop: nothing
 * downstream runs until a holder of one of these moves an entry along. This
 * mirrors the cluster:admin gate used by agent approval.
 */
export const FEEDBACK_MANAGE_PERMISSIONS: Permission[] = ["rbac:admin", "cluster:admin"];

/**
 * Shared guard for the feedback review surface: the canonical-host gate
 * (403 with the route's message) followed by the manager RBAC check.
 * Returns the session on success, or the error Response to bubble up:
 *
 *   const session = await requireFeedbackManager(request, "… canonical console host");
 *   if (session instanceof Response) return session;
 */
export async function requireFeedbackManager(
  request: NextRequest,
  hostGateMessage: string,
): Promise<Session | NextResponse> {
  if (!isFeedbackHost(request.headers)) {
    return apiError(hostGateMessage, { status: 403 });
  }
  return requireRoutePermissions({ any: FEEDBACK_MANAGE_PERMISSIONS });
}
