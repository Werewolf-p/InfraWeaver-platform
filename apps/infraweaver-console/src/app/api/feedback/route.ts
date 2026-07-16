import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import {
  createFeedback,
  listFeedback,
  FEEDBACK_TYPES,
  FEEDBACK_SEVERITIES,
  type FeedbackSeverity,
  type FeedbackType,
} from "@/lib/feedback-store";
import { isDispatchConfigured } from "@/lib/feedback-dispatch";
import { FEEDBACK_MANAGE_PERMISSIONS } from "@/lib/feedback-host";
import { needsReconcile, reconcileStaleEntries } from "@/lib/feedback-pipeline";
import { signHmac, verifyHmac, HMAC_SKEW_MS } from "@/lib/hmac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";

// Any authenticated user may submit/list feedback context.
const SUBMIT: Permission[] = ["apps:read", "cluster:read"];

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE INTENTIONALLY-HARDCODED VALUE IN INFRAWEAVER.
//
// Every forked deployment reports user feedback back to the canonical
// InfraWeaver endpoint so the maintainers can keep improving the platform for
// all forks. This is deliberately a constant and is NOT environment-overridable,
// so every fork reports to the same canonical endpoint regardless of local config.
const FEEDBACK_URL = "https://infraweaver.rlservers.com/api/feedback";

// C2 (SECURITY-SCAN-2026-07-08): cross-deployment ("upstream") ingest is gated by
// a shared HMAC between fork and canonical — NOT a client-settable header. A fork
// signs each forwarded copy with the shared secret; the canonical verifies it and
// only then bypasses auth. The signed forward also serves as the loop guard: a
// request carrying a valid signature is a forwarded copy and is NOT re-forwarded.
// The signature headers follow the canonical scheme in hmac.ts.
const UPSTREAM_TIMESTAMP_HEADER = "x-iw-timestamp";
const UPSTREAM_SIGNATURE_HEADER = "x-iw-signature";

// Unauthenticated + auto-deploy-adjacent, so rate-limit every submission per IP.
const FEEDBACK_RATE_LIMIT = { max: 20, windowMs: 60_000 };

// Replay guard for upstream ingest. A valid signature stays acceptable for its
// full ±HMAC_SKEW_MS window, so a captured signature could be replayed verbatim
// within that window. Track each verified signature until it can no longer pass
// the timestamp check (worst case: seen at now == ts − skew, replayable until
// now == ts + skew), i.e. 2×HMAC_SKEW_MS after first sight, then reject repeats.
const REPLAY_RETENTION_MS = 2 * HMAC_SKEW_MS;
const seenUpstreamSignatures = new Map<string, number>();

/**
 * Record a just-verified upstream signature and report whether it is a replay.
 * Returns `false` when the signature has already been seen inside its validity
 * window (reject the request); `true` for a first-seen signature. Prunes expired
 * entries on each call so the map stays bounded by the active replay window.
 */
function registerUpstreamSignature(signature: string, now: number): boolean {
  for (const [seen, expiry] of seenUpstreamSignatures) {
    if (expiry <= now) seenUpstreamSignatures.delete(seen);
  }
  if (seenUpstreamSignatures.has(signature)) return false;
  seenUpstreamSignatures.set(signature, now + REPLAY_RETENTION_MS);
  return true;
}

/** Shared fork↔canonical secret. When unset, upstream ingest/forward are disabled (fail-closed). */
function upstreamSecret(): string {
  return process.env.FEEDBACK_UPSTREAM_SECRET ?? "";
}

// Fire-and-forget a sanitized, HMAC-signed copy of a feedback entry to the
// canonical endpoint. Non-blocking and failure-swallowing: it must never affect
// the local user's response or throw into the request path. Skipped entirely
// when no shared secret is configured — an unsigned copy would be rejected.
function forwardToCanonical(payload: {
  description: string;
  type: FeedbackType;
  pagePath: string;
  severity?: FeedbackSeverity;
}) {
  const secret = upstreamSecret();
  if (!secret) return;
  const ts = Date.now().toString();
  const body = JSON.stringify(payload);
  const signature = signHmac(`${ts}.${body}`, secret);
  void fetch(FEEDBACK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [UPSTREAM_TIMESTAMP_HEADER]: ts,
      [UPSTREAM_SIGNATURE_HEADER]: signature,
    },
    body,
  }).catch(() => {
    // Intentionally ignored — upstream reporting is best-effort.
  });
}

// GET /api/feedback — list collected feedback entries (auth-gated).
export async function GET() {
  const session = await requireRoutePermissions({ any: SUBMIT });
  if (session instanceof Response) return session;
  try {
    let entries = await listFeedback();
    // Self-heal entries stranded mid-run by a console restart (`approved` with no
    // write-back, or `dispatched` with no preview URL), so the dashboard reflects
    // finished dispatch runs and backfills their preview URLs without manual
    // intervention.
    // Reconciliation on the read path issues outbound dispatch calls (a state
    // mutation), so it is gated to feedback managers — the same set every
    // feedback management route uses. Low-privilege readers get the list as-is.
    if (isDispatchConfigured() && entries.some(needsReconcile)) {
      const access = await getSessionRBACContext(session, 60);
      if (hasAnySessionPermission(access, FEEDBACK_MANAGE_PERMISSIONS)) {
        await reconcileStaleEntries(entries);
        entries = await listFeedback();
      }
    }
    return apiSuccess({ entries });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

interface CreateFeedbackBody {
  description?: string;
  type?: string;
  pagePath?: string;
  severity?: string;
}

// POST /api/feedback — capture a new feedback entry.
//
// Two paths:
//  • Normal user (auth-gated): store locally, then fire-and-forward an HMAC-signed
//    copy to the canonical InfraWeaver endpoint (FEEDBACK_URL).
//  • Upstream copy (carries a VALID HMAC signature): an anonymous cross-deployment
//    submission forwarded from another fork. Auth is bypassed only after the
//    signature verifies; it is NOT forwarded again — the canonical ingests it here.
export async function POST(request: NextRequest) {
  // Rate-limit every submission per client IP (covers both the unauthenticated
  // upstream path and normal users).
  if (!checkRateLimit(rateLimitKey("feedback", request), FEEDBACK_RATE_LIMIT.max, FEEDBACK_RATE_LIMIT.windowMs)) {
    return apiError("Too many requests", { status: 429 });
  }

  // Read the raw body once — the HMAC is computed over these exact bytes.
  const rawBody = await request.text().catch(() => "");

  const timestamp = request.headers.get(UPSTREAM_TIMESTAMP_HEADER);
  const signature = request.headers.get(UPSTREAM_SIGNATURE_HEADER);

  let isUpstream = false;
  if (timestamp || signature) {
    // A cross-deployment copy claiming to be signed. Fail closed: a bad/expired
    // signature, or no shared secret configured, is rejected — it must never fall
    // through to the auth-gated path or the anonymous ingest.
    const now = Date.now();
    const ok = verifyHmac({ timestamp, signature, rawBody, secret: upstreamSecret(), now });
    if (!ok) return apiError("Invalid upstream signature", { status: 401 });
    // Signature is authentic and in-window; reject a verbatim replay of it.
    if (!signature || !registerUpstreamSignature(signature, now)) {
      return apiError("Replayed upstream signature", { status: 401 });
    }
    isUpstream = true;
  }

  let actor = "upstream-fork";
  if (!isUpstream) {
    const session = await requireRoutePermissions({ any: SUBMIT });
    if (session instanceof Response) return session;
    actor = session.user?.email ?? "unknown";
  }

  try {
    let parsedBody: CreateFeedbackBody = {};
    try {
      parsedBody = rawBody ? (JSON.parse(rawBody) as CreateFeedbackBody) : {};
    } catch {
      // Malformed JSON — leave empty so the field validation below returns 400.
    }
    const description = parsedBody.description?.trim();
    const type = parsedBody.type as FeedbackType;
    const pagePath = parsedBody.pagePath?.trim();
    const severity = parsedBody.severity as FeedbackSeverity | undefined;

    if (!description) return apiError("description is required", { status: 400 });
    if (description.length > 4000) return apiError("description too long", { status: 400 });
    if (!FEEDBACK_TYPES.includes(type)) return apiError("Invalid feedback type", { status: 400 });
    if (!pagePath) return apiError("pagePath is required", { status: 400 });
    if (severity !== undefined && !FEEDBACK_SEVERITIES.includes(severity)) {
      return apiError("Invalid severity", { status: 400 });
    }

    const entry = await createFeedback({ description, type, pagePath, severity }, actor);

    // Only original (locally-submitted) feedback is forwarded upstream; signed
    // forwarded copies are not re-forwarded (loop guard).
    if (!isUpstream) {
      forwardToCanonical({ description, type, pagePath, severity });
    }

    return apiSuccess({ entry }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
