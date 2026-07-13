import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionEffectivePermissions, getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { applyRoleAssignments } from "@/lib/rbac-assignments";
import { ensureEnrollmentInviteFor } from "@/lib/users/reconcile";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;
const SAFE_GROUP_RE = /^[\w .@+/-]{1,100}$/;

const grantDraftSchema = z.object({
  roleId: z.string().min(1).max(100),
  scope: z.string().min(1).max(200),
  expiresAt: z.string().max(100).optional(),
  effect: z.enum(["Allow", "Deny"]).optional(),
});

const applyBodySchema = z
  .object({
    username: z.string().min(1).max(100).optional(),
    group: z.string().min(1).max(100).optional(),
    principalType: z.enum(["user", "group"]).optional(),
    grants: z.array(grantDraftSchema).max(50).default([]),
    revokes: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict();

/**
 * Batch apply role-assignment changes for a single principal in one write.
 *
 * PUT (not POST) because it reconciles a principal's assignments toward a desired
 * set of deltas — idempotent in spirit and distinct from the single-grant POST on
 * the parent route. A role swap sent here is one commit and one "changed" email,
 * where delete-then-add via the single-delta endpoints would be two of each.
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  const result = applyBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }
  const body = result.data;

  for (const grant of body.grants) {
    if (!SAFE_SCOPE_RE.test(grant.scope)) return NextResponse.json({ error: `Invalid scope '${grant.scope}'` }, { status: 400 });
  }

  const principalType = body.principalType ?? (body.group ? "group" : "user");
  const rawPrincipal = principalType === "group" ? (body.group ?? body.username) : body.username;
  if (!rawPrincipal) return NextResponse.json({ error: "Missing principal (username or group)" }, { status: 400 });
  // Trim group names before validation/persist: SAFE_GROUP_RE allows internal
  // spaces, so a padded " platform-admins" would otherwise pass and be stored as
  // a distinct users.yaml key no (trimmed) session group can match. A name that
  // is only whitespace trims to "" and fails the min-length regex below.
  const principal = principalType === "group" ? rawPrincipal.trim() : rawPrincipal;
  if (principalType === "group" && !SAFE_GROUP_RE.test(principal)) return NextResponse.json({ error: "Invalid group name" }, { status: 400 });

  if (body.grants.length === 0 && body.revokes.length === 0) {
    return NextResponse.json({ error: "No changes to apply" }, { status: 400 });
  }

  const granterPermsAt = (scope: string) => getSessionEffectivePermissions(access, scope);
  const actor = session.user?.email ?? "unknown";
  try {
    const outcome = await applyRoleAssignments(
      { principalType, principal, grants: body.grants, revokes: body.revokes },
      { granterPermsAt, actor },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    // Fully-automated onboarding: granting access to a user who has no Authentik
    // login yet auto-sends their enrollment ("setup") mail so they never sit
    // access-less waiting for an operator. Fire-and-forget and self-swallowing —
    // it must never fail or delay the grant. Groups/skip logic live in the helper.
    if (principalType === "user" && outcome.grantedCount > 0) {
      void ensureEnrollmentInviteFor(principal).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      assignments: outcome.assignments.map((a) => ({ ...a, username: principal })),
      grantedCount: outcome.grantedCount,
      revokedCount: outcome.revokedCount,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
