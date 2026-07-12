import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { validateK8sName } from "@/lib/api-security";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, type GameHubAccessContext } from "@/lib/logs-access";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import type { Permission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";
import { hasGameHubPermission } from "./game-hub";
import { isKubernetesNotFoundError } from "./game-hub-server";

// ─────────────────────────────────────────────────────────────────────────────
// next/server-coupled route-handler helpers, split out of game-hub-server.ts so
// the domain lib no longer imports next/server. Behavior is unchanged — these
// mirror the EXISTING handler guard/error boilerplate byte-for-byte (envelopes,
// ordering, status codes) so callers keep working via the `@/lib/game-hub-server`
// shim, which re-exports this module.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolved scoped-RBAC context, as returned by getGameHubAccessContext. */
export type { GameHubAccessContext };

/** RBAC context cache window (seconds) used by every game-hub route. */
const GAME_HUB_ACCESS_REVALIDATE_SECONDS = 60;

export interface GameHubRouteContext<P extends { name: string } = { name: string }> {
  req: NextRequest;
  session: Session;
  /** Validated `[name]` route segment (K8s-name checked). */
  name: string;
  /** Scoped RBAC access context (60s revalidate window, matching existing routes). */
  access: GameHubAccessContext;
  /** All resolved dynamic route params. */
  params: P;
}

export interface WithGameHubAuthOptions {
  /** Per-server permission required (checked against the `/game-hub/servers/<name>` scope). */
  permission: Permission;
  /** Optional rate limit applied BEFORE auth, matching existing game-hub handlers. */
  rateLimit?: { name: string; limit: number; windowMs: number };
}

/**
 * Wrap a per-server game-hub route handler with the guard chain every
 * `/api/game-hub/servers/[name]/...` handler currently repeats inline:
 *
 *   (optional) rate limit → 429 { error: "Rate limit exceeded" }
 *   auth()                → 401 { error: "Unauthorized" }
 *   await params → validateK8sName(name) → 400 (SecurityError envelope)
 *   getGameHubAccessContext(session, 60) → hasGameHubPermission(..., name)
 *                         → 403 { error: "Forbidden" }
 *
 * Error handling inside the handler is intentionally left to the caller (use
 * {@link toApiErrorResponse}) so each route keeps its own catch envelope.
 */
export function withGameHubAuth<P extends { name: string } = { name: string }>(
  options: WithGameHubAuthOptions,
  handler: (ctx: GameHubRouteContext<P>) => Promise<Response> | Response,
): (req: NextRequest, segment: { params: Promise<P> }) => Promise<Response> {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    if (options.rateLimit) {
      const { name: limitName, limit, windowMs } = options.rateLimit;
      if (!checkRateLimit(rateLimitKey(limitName, req), limit, windowMs)) {
        return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      }
    }

    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = await segment.params;
    const { name } = params;
    const nameErr = validateK8sName(name);
    if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

    const access = await getGameHubAccessContext(session, GAME_HUB_ACCESS_REVALIDATE_SECONDS);
    if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, options.permission, name)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return handler({ req, session, name, access, params });
  };
}

/**
 * The canonical game-hub catch envelope, identical to the pattern repeated in
 * ~50 route handlers:
 *
 *   console.error(label, error);
 *   not-found  → 404 { error: "Not found" }
 *   otherwise  → 500 { error: safeError(error) }
 *
 * Routes with extra branches (e.g. isServerStartingError → 503) should check
 * those BEFORE falling through to this helper.
 */
export function toApiErrorResponse(error: unknown, label: string): NextResponse {
  console.error(label, error);
  if (isKubernetesNotFoundError(error)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ error: safeError(error) }, { status: 500 });
}
