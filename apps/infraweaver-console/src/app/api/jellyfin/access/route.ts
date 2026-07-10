// GET    /api/jellyfin/access  — who has Jellyfin, and the launch URL.
// POST   /api/jellyfin/access  — grant Jellyfin (provisions the local account).
// DELETE /api/jellyfin/access  — revoke (disables the local account).
// PUT    /api/jellyfin/access  — force a reconcile of accounts against RBAC.
//
// Why local accounts at all: Jellyfin's OIDC plugin covers only its web UI.
// Native and TV clients authenticate against a Jellyfin account with a password,
// so "granting someone Jellyfin" has to materialize one. A grant here is an
// ordinary RBAC RoleAssignment at `/jellyfin`; `lib/jellyfin/access.ts` turns the
// resulting authorized set into accounts, and a revoke disables the account
// rather than deleting it, so watch history survives a re-grant.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jellyfinLaunchUrl } from "@/lib/jellyfin/config";
import { JELLYFIN_SCOPE } from "@/lib/jellyfin/access";
import { grantRoleAssignment, revokeRoleAssignment } from "@/lib/rbac-assignments";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import {
  getSessionEffectivePermissions,
  getSessionRBACContext,
  hasAnySessionPermission,
} from "@/lib/session-rbac";
import { loadUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";
import { z } from "zod";

/** Mirrors the storage access route: only the Jellyfin tiers are grantable here. */
const JELLYFIN_ROLE_IDS = ["jellyfin-user", "jellyfin-admin"] as const;

const GrantSchema = z.object({
  roleId: z.enum(JELLYFIN_ROLE_IDS),
  principalType: z.enum(["user", "group"]),
  principal: z.string().min(1).max(100),
  expiresAt: z.string().max(100).optional(),
}).strict();

const RevokeSchema = z.object({
  assignmentId: z.string().min(1).max(100),
  principalType: z.enum(["user", "group"]),
  principal: z.string().min(1).max(100),
}).strict();

type Rbac = Awaited<ReturnType<typeof getSessionRBACContext>>;

/** Managing who gets an account is an RBAC-admin act, not merely a Jellyfin one. */
function canManageGrants(rbac: Rbac): boolean {
  return hasAnySessionPermission(rbac, ["users:write", "rbac:admin"]);
}

/** Every assignment bearing on Jellyfin: at `/jellyfin` or at the root. */
function isJellyfinGrantScope(scope: string): boolean {
  return scope === "/" || scope === JELLYFIN_SCOPE || scope.startsWith(`${JELLYFIN_SCOPE}/`);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(rbac, ["users:read", "rbac:admin", "jellyfin:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("jellyfin-access-get", req), 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const file = await loadUsersConfig();
    const grants = [];
    for (const [username, user] of Object.entries(file.users)) {
      for (const assignment of user.role_assignments ?? []) {
        if (isJellyfinGrantScope(assignment.scope)) {
          grants.push({ ...assignment, principalType: "user" as const, principalId: username });
        }
      }
    }
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const assignment of group.role_assignments ?? []) {
        if (isJellyfinGrantScope(assignment.scope)) {
          grants.push({ ...assignment, principalType: "group" as const, principalId: assignment.principalId || groupName });
        }
      }
    }

    return NextResponse.json({
      scope: JELLYFIN_SCOPE,
      launchUrl: jellyfinLaunchUrl(),
      canManage: canManageGrants(rbac),
      grants: grants.sort((a, b) => a.principalId.localeCompare(b.principalId)),
      candidates: {
        users: Object.entries(file.users)
          .map(([username, user]) => ({ username, name: user.name ?? username, email: user.email ?? "" }))
          .sort((a, b) => a.username.localeCompare(b.username)),
        groups: Object.keys(file.groups).sort(),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!canManageGrants(rbac)) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("jellyfin-access-grant", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = GrantSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // The grant is the whole act: `grantRoleAssignment` enforces the privilege
    // ceiling, writes users.yaml, audits, and fans out to
    // `reconcileJellyfinAccessWithRetry`, which creates the local account and
    // stores its generated password.
    const outcome = await grantRoleAssignment(
      { ...parsed.data, scope: JELLYFIN_SCOPE },
      { granterPerms: getSessionEffectivePermissions(rbac, "/"), actor: session.user?.email ?? "unknown" },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true, assignment: outcome.assignment });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!canManageGrants(rbac)) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });

  const parsed = RevokeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await revokeRoleAssignment(parsed.data, {
      granterPerms: getSessionEffectivePermissions(rbac, "/"),
      actor: session.user?.email ?? "unknown",
    });
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

/** Force-reconcile accounts against RBAC — the escape hatch for a failed fan-out. */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!canManageGrants(rbac)) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("jellyfin-access-sync", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const { syncJellyfinUsers } = await import("@/lib/jellyfin/access");
    return NextResponse.json({ ok: true, ...(await syncJellyfinUsers()) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
