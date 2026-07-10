// GET    /api/nas/access?provider&share&path  — who can reach this folder, and why.
// POST   /api/nas/access                      — grant a storage role on the folder.
// DELETE /api/nas/access                      — revoke a grant.
// PUT    /api/nas/access                      — force-reconcile the share's Authentik groups.
//
// This is the API behind the storage access panel. It is a thin, storage-shaped
// facade over the ordinary RBAC assignment machinery (`lib/rbac-assignments`),
// so every grant made here is an audited, expirable, ceiling-checked
// RoleAssignment that shows up in the RBAC visualizer alongside every other
// grant. Storage stopped being a special case; it is now a scope.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listStorageGrantsForScope, storageAccessGroupName } from "@/lib/nas/access-policy";
import { canReadStorage, canTraverseNasFolder } from "@/lib/nas/authz";
import { describeNasScope, nasFolderScope, NasScopeError } from "@/lib/nas/scope";
import { normalizeSubfolder } from "@/lib/nas/paths";
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

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHARE_RE = /^[a-z0-9][a-z0-9\-_]*$/i;

/**
 * Only the storage roles may be granted through this endpoint. The generic
 * `/api/rbac/assignments` route remains available to a full RBAC admin; this one
 * exists so the storage UI cannot become a path to conferring, say,
 * `platform-owner` on a folder scope.
 */
const STORAGE_ROLE_IDS = ["storage-viewer", "storage-contributor"] as const;

const LocationSchema = z.object({
  provider: z.string().min(1).max(63).regex(PROVIDER_RE),
  share: z.string().min(1).max(63).regex(SHARE_RE),
  path: z.string().max(200).optional(),
});

const GrantSchema = LocationSchema.extend({
  roleId: z.enum(STORAGE_ROLE_IDS),
  principalType: z.enum(["user", "group"]),
  principal: z.string().min(1).max(100),
  expiresAt: z.string().max(100).optional(),
}).strict();

const RevokeSchema = z.object({
  assignmentId: z.string().min(1).max(100),
  principalType: z.enum(["user", "group"]),
  principal: z.string().min(1).max(100),
}).strict();

/** Managing grants is an RBAC-admin act, not merely a storage act. */
function canManageGrants(rbac: Awaited<ReturnType<typeof getSessionRBACContext>>): boolean {
  return hasAnySessionPermission(rbac, ["users:write", "rbac:admin"]);
}

type ScopeResolution =
  | { ok: true; subfolder: string; scope: string }
  | { ok: false; response: NextResponse };

/**
 * Resolve a folder to its RBAC scope, or explain why it has none.
 *
 * A folder whose name is not scope-addressable — the RBAC scope grammar is
 * `[a-z0-9_-]` per segment, so `Season.01` is out — cannot carry a grant of its
 * own. That is a 400 with a usable message, not a 500: the operator's move is to
 * grant on the share (or any clean-named ancestor), which inherits down.
 */
function resolveScope(provider: string, share: string, path: string | undefined): ScopeResolution {
  let subfolder: string;
  try {
    subfolder = normalizeSubfolder(path ?? "");
  } catch (error) {
    return { ok: false, response: NextResponse.json({ error: safeError(error) }, { status: 400 }) };
  }
  try {
    return { ok: true, subfolder, scope: nasFolderScope(provider, share, subfolder) };
  } catch (error) {
    if (error instanceof NasScopeError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `${error.message}. Grant on an ancestor folder or the share instead — grants inherit downwards.`, notScopeAddressable: true },
          { status: 400 },
        ),
      };
    }
    throw error;
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!canReadStorage(rbac)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-access-get", req), 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = LocationSchema.safeParse({
    provider: req.nextUrl.searchParams.get("provider") ?? undefined,
    share: req.nextUrl.searchParams.get("share") ?? undefined,
    path: req.nextUrl.searchParams.get("path") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "provider and share params required" }, { status: 400 });

  const { provider, share } = parsed.data;
  const resolved = resolveScope(provider, share, parsed.data.path);
  if (!resolved.ok) return resolved.response;
  const { subfolder, scope } = resolved;

  // Seeing WHO has access to a folder is itself a disclosure about that folder,
  // so it requires the same reachability as listing it.
  if (!canTraverseNasFolder(rbac, { provider, share, subfolder })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {

    const file = await loadUsersConfig();
    const grants = listStorageGrantsForScope(scope, file.users, file.groups);

    return NextResponse.json({
      scope,
      label: describeNasScope(scope),
      grants,
      canManage: canManageGrants(rbac),
      // The Authentik groups whose membership this scope's grants drive. An
      // external-storage mount (Nextcloud) binds these names, so the operator
      // needs to see them.
      accessGroups: {
        readonly: storageAccessGroupName(provider, share, "readonly", subfolder),
        readwrite: storageAccessGroupName(provider, share, "readwrite", subfolder),
      },
      // Candidate principals for the assignment popup. Sourced from users.yaml so
      // the list matches what `grantRoleAssignment` can actually persist to.
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
  if (!checkRateLimit(rateLimitKey("nas-access-grant", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = GrantSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const { provider, share, roleId, principalType, principal, expiresAt } = parsed.data;
  const resolved = resolveScope(provider, share, parsed.data.path);
  if (!resolved.ok) return resolved.response;
  const { scope } = resolved;

  try {
    // `grantRoleAssignment` enforces the privilege ceiling (never confer what you
    // do not hold), writes users.yaml, audits, and fans the change out to the
    // share's Authentik groups so Nextcloud's view converges.
    const outcome = await grantRoleAssignment(
      { roleId, scope, principalType, principal, expiresAt },
      { granterPerms: getSessionEffectivePermissions(rbac, "/"), actor: session.user?.email ?? "unknown" },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true, assignment: outcome.assignment, scope });
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
    const outcome = await revokeRoleAssignment(
      { assignmentId: parsed.data.assignmentId, principalType: parsed.data.principalType, principal: parsed.data.principal },
      { granterPerms: getSessionEffectivePermissions(rbac, "/"), actor: session.user?.email ?? "unknown" },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

/**
 * Force-reconcile the share's Authentik access groups. The grant path already
 * does this in the background; this is the manual escape hatch for when that
 * fan-out failed (a transient Authentik outage) or when a broad `/nas` grant was
 * made, which is deliberately not fanned out per share.
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  if (!canManageGrants(rbac)) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-access-sync", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = LocationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "provider and share required" }, { status: 400 });

  const resolved = resolveScope(parsed.data.provider, parsed.data.share, parsed.data.path);
  if (!resolved.ok) return resolved.response;

  try {
    const { syncShareAccess } = await import("@/lib/nas/access");
    const result = await syncShareAccess(parsed.data.provider, parsed.data.share, resolved.subfolder);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
