import "server-only";
import { authentikFetch, findUserByEmail } from "@/lib/authentik";
import { applyRoleAssignments } from "@/lib/rbac-assignments";
import { getSessionEffectivePermissions, type SessionRBACContext } from "@/lib/session-rbac";
import { scopeLabel, resolveRoleDefinition } from "@/lib/rbac";
import { expandPvc } from "@/lib/storage/expand-pvc";
import { describeNasScope } from "@/lib/nas/scope";
import { findUserByIdentity, loadUsersConfig } from "@/lib/users-config";
import type {
  AppAccessPayload,
  ProfileUpdatePayload,
  SelfServiceRequest,
  StorageQuotaPayload,
} from "./types";

/**
 * Self-service apply executors — SERVER ONLY.
 *
 * Every executor is used by BOTH the auto-apply path (run under the requester's
 * own ceiling) and the approval path (run under the approver's ceiling). None of
 * them forks a primitive: app-access reuses the single grant choke point
 * (applyRoleAssignments — ceiling-enforced, downstream reconcile + change-email +
 * audit for free), storage-quota reuses expandPvc, password reset/profile update
 * reuse the same Authentik calls the existing self-service routes make.
 *
 * Auditing lives in the API routes (submit/approve), not here, so an executor is
 * a pure "perform the primitive, report the outcome" unit.
 */

export type ApplyOutcome =
  | { ok: true; summary: string; recoveryLink?: string }
  | { ok: false; status: number; error: string };

/** Context an executor needs to enforce the acting principal's ceiling. */
export interface ApplyContext {
  /** The principal whose ceiling bounds the write (requester on auto, approver on approve). */
  actorCtx: SessionRBACContext;
  /** Audit/commit actor identity. */
  actor: string;
}

function roleLabel(roleId: string): string {
  return resolveRoleDefinition(roleId)?.name ?? roleId;
}

/**
 * Resolve the requester's canonical users.yaml KEY from their submit identity
 * (usually an email). applyRoleAssignments looks up `file.users[principal]`, so a
 * grant must target the users.yaml key, not the session email. Returns null when
 * the requester has no users.yaml record (grant would be a 404 — fail closed).
 */
async function resolveUserPrincipal(requestedBy: string): Promise<string | null> {
  const cfg = await loadUsersConfig();
  const match = findUserByIdentity(cfg.users, { username: requestedBy, email: requestedBy });
  return match?.username ?? null;
}

/**
 * Grant the requested role via the single choke point. `granterPermsAt` resolves
 * the ACTING principal's effective permissions per-scope, so applyRoleAssignments
 * re-enforces the ceiling itself — belt-and-suspenders over evaluate(): even the
 * auto path (actorCtx = requester) cannot escalate, and a mismatch surfaces as the
 * choke point's own 403 rather than a silent over-grant.
 */
export async function applyAppAccess(request: SelfServiceRequest, ctx: ApplyContext): Promise<ApplyOutcome> {
  const payload = request.payload as AppAccessPayload;
  const principal = await resolveUserPrincipal(request.requestedBy);
  if (!principal) return { ok: false, status: 404, error: "Requester has no users.yaml record to grant against" };
  const result = await applyRoleAssignments(
    {
      principalType: "user",
      principal,
      grants: [{ roleId: payload.roleId, scope: payload.scope, ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) }],
      revokes: [],
    },
    {
      granterPermsAt: (scope) => getSessionEffectivePermissions(ctx.actorCtx, scope),
      actor: ctx.actor,
    },
  );
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, summary: `Granted ${roleLabel(payload.roleId)} at ${scopeLabel(payload.scope)}` };
}

/**
 * Expand the target PVC. The PVC patch is `cluster:admin`-only, so this executor
 * only ever runs on the approval path (evaluate() never auto-applies storage
 * quota) under an approver the route has already confirmed holds cluster:admin.
 */
export async function applyStorageQuota(request: SelfServiceRequest): Promise<ApplyOutcome> {
  const payload = request.payload as StorageQuotaPayload;
  try {
    const pvc = await expandPvc({ namespace: payload.namespace, name: payload.pvcName, newSize: payload.requestedSize });
    return {
      ok: true,
      summary: `Expanded PVC ${describeNasScope(payload.scope)} (${pvc.namespace}/${pvc.name}) to ${pvc.requestedStorage}`,
    };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "PVC expand failed" };
  }
}

/**
 * Start Authentik's recovery flow for the requester's OWN account and return the
 * one-time link in the API response only — it is never persisted (appliedSummary
 * records that a link was issued, not the link itself).
 */
export async function applyPasswordReset(request: SelfServiceRequest): Promise<ApplyOutcome> {
  const user = (await findUserByEmail(request.requestedBy)) as { pk?: number } | null;
  if (!user?.pk) return { ok: false, status: 404, error: "Your account was not found in Authentik" };

  const response = await authentikFetch(`/core/users/${user.pk}/recovery/`, { method: "POST" });
  if (!response.ok) return { ok: false, status: 502, error: "Failed to start password recovery" };

  const data = (await response.json().catch(() => ({}))) as { link?: string };
  if (!data.link) return { ok: false, status: 502, error: "Failed to start password recovery" };

  return { ok: true, summary: "Password recovery link issued to your email", recoveryLink: data.link };
}

/** PATCH the requester's own Authentik display name or email (own-identity, auto-apply). */
export async function applyProfileUpdate(request: SelfServiceRequest): Promise<ApplyOutcome> {
  const payload = request.payload as ProfileUpdatePayload;
  const user = (await findUserByEmail(request.requestedBy)) as { pk?: number } | null;
  if (!user?.pk) return { ok: false, status: 404, error: "Your account was not found in Authentik" };

  const response = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ [payload.field]: payload.value }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Profile update failed" };

  return { ok: true, summary: `Updated ${payload.field}` };
}

/**
 * Dispatch a request to its executor. `ctx.actorCtx` is the requester on the
 * auto path and the approver on the approval path — either way the write is
 * bounded by that principal's ceiling.
 */
export async function executeRequest(request: SelfServiceRequest, ctx: ApplyContext): Promise<ApplyOutcome> {
  switch (request.type) {
    case "app-access":
      return applyAppAccess(request, ctx);
    case "storage-quota":
      return applyStorageQuota(request);
    case "password-reset":
      return applyPasswordReset(request);
    case "profile-update":
      return applyProfileUpdate(request);
    default:
      return { ok: false, status: 400, error: "Unknown request type" };
  }
}
