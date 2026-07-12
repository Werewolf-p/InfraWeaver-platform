/**
 * Shared guards and helpers for the user-lifecycle and profile API routes.
 */
import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { ZodType } from "zod";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch, findUserByEmail, findUserByUsername } from "@/lib/authentik";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { hasSessionPermission, type SessionRBACContext } from "@/lib/session-rbac";
import { loadUsersConfig, saveUsersConfig, type UsersConfigUser } from "@/lib/users-config";
import { errorMessage } from "@/lib/utils";

/** The Authentik user fields the account-recovery routes rely on. */
export interface AuthentikUser {
  pk: number;
  username?: string;
  email?: string;
  is_superuser?: boolean;
  groups?: unknown[];
}

/** Canonical audit-log actor identity for a session. */
export function sessionActor(session: Session): string {
  return session.user?.email ?? "unknown";
}

/**
 * Resolve the target of a privileged account-recovery action (email change,
 * MFA reset, enable/disable, rename, password reset).
 *
 * C3 (SECURITY-AUDIT): each of these actions can take over or lock out an
 * account, so on top of the route's users:write / rbac:admin gate a privilege
 * ceiling applies — a non-rbac:admin operator must never be able to redirect a
 * superuser/admin account's recovery email, strip its second factor, disable
 * it, rename it, or reset its credentials. Returns the canonical 404 when the
 * user does not exist in Authentik and the canonical 403 when the ceiling
 * blocks the caller.
 *
 * Usage:
 *   const user = await resolvePrivilegedUserTarget(access, username);
 *   if (user instanceof NextResponse) return user;
 */
export async function resolvePrivilegedUserTarget(
  access: SessionRBACContext,
  username: string,
): Promise<AuthentikUser | NextResponse> {
  const user = (await findUserByUsername(username)) as AuthentikUser | null;
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });
  if (user.is_superuser === true && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json({ error: "Forbidden: target account requires rbac:admin" }, { status: 403 });
  }
  return user;
}

/**
 * Best-effort users.yaml update after an Authentik write already succeeded.
 * The mutator edits the loaded users map in place and returns false to skip
 * the save (e.g. the user has no users.yaml record). Failures are non-fatal —
 * Authentik is already updated — but logged so config drift stays visible.
 */
export async function bestEffortUsersConfigUpdate(
  mutator: (users: Record<string, UsersConfigUser>) => boolean,
  commitMessage: string,
): Promise<void> {
  try {
    const { users, sha } = await loadUsersConfig();
    if (!mutator(users)) return;
    await saveUsersConfig(users, sha, commitMessage);
  } catch (error) {
    console.warn(`[users] best-effort users.yaml update failed (${commitMessage}): ${errorMessage(error)}`);
  }
}

export interface SelfProfilePatchConfig<T> {
  /** Rate-limit bucket name (5 requests / minute, matching the profile routes). */
  rateKey: string;
  schema: ZodType<T>;
  /** Authentik user field the parsed value is PATCHed onto. */
  field: "name" | "email";
  /** Extracts the new field value from the validated body. */
  value: (body: T) => string;
  auditAction: string;
  auditDetail: (value: string) => string;
}

/**
 * Factory for the self-service profile PATCH routes (display name, email):
 * rate-limit → validate body → resolve own Authentik user → PATCH field → audit.
 */
export function makeSelfProfilePatchRoute<T>(config: SelfProfilePatchConfig<T>) {
  return withRoute(null, async (req: NextRequest, session) => {
    if (!checkRateLimit(rateLimitKey(config.rateKey, req), 5, 60_000)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const parsed = config.schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const value = config.value(parsed.data);

    const email = (session.user as { email?: string }).email ?? "";
    const user = await findUserByEmail(email);
    if (!user?.pk) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const r = await authentikFetch(`/core/users/${user.pk}/`, {
      method: "PATCH",
      body: JSON.stringify({ [config.field]: value }),
    });
    if (!r.ok) return NextResponse.json({ error: "Update failed" }, { status: 502 });

    await auditLog(config.auditAction, sessionActor(session), config.auditDetail(value), {
      resource: "profile",
      req,
    });

    return NextResponse.json({ ok: true });
  });
}
