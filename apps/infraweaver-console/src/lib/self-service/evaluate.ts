import {
  expandPermissionPattern,
  resolveRoleDefinition,
  type Permission,
} from "@/lib/rbac";
import { permissionsBeyondCeiling, type SessionRBACContext } from "@/lib/session-rbac";
import type {
  AppAccessPayload,
  ProfileUpdatePayload,
  SelfServiceRequest,
  SelfServiceRequestType,
  StorageQuotaPayload,
} from "./types";

/**
 * The RBAC-ceiling guard — the security core of self-service.
 *
 * CENTRAL INVARIANT (see subject plan):
 *   autoApply = permissionsBeyondCeiling(requesterCtx, perms, scope) is EMPTY
 *               AND the requester can self-execute the primitive
 *
 * Within the requester's ceiling AND self-executable → apply now under the
 * requester's OWN ceiling (a no-op-safe reconcile the platform already deems
 * them entitled to). Otherwise → queue for an admin, who applies it under the
 * APPROVER's ceiling through the enforced grant path. A self-request can NEVER
 * self-escalate: the `beyond`-empty test IS `permissionsBeyondCeiling`, so any
 * permission the requester does not already hold forces the approval route.
 */

/** The concrete permissions + scope a request would confer if applied. */
export interface RequestedPerms {
  perms: Permission[];
  scope: string;
}

/**
 * The permissions/scope each request type confers. `app-access` expands the
 * requested role's granted patterns to concrete permissions so the ceiling test
 * is byte-for-byte the same set `assignmentExceedsGranter` evaluates on the grant
 * path — evaluate and apply can never disagree. Password/profile confer no
 * permission (own-identity actions), so their `perms` is empty ⇒ always within
 * ceiling. Storage-quota's ceiling anchor is `nas:write` at the PVC's share scope.
 */
export function requestedPermsFor(request: SelfServiceRequest): RequestedPerms {
  switch (request.type) {
    case "app-access": {
      const payload = request.payload as AppAccessPayload;
      const role = resolveRoleDefinition(payload.roleId);
      const perms = role
        ? role.permissions.flatMap((pattern) =>
            pattern === "*" ? (["*"] as Permission[]) : expandPermissionPattern(pattern),
          )
        : [];
      return { perms, scope: payload.scope };
    }
    case "storage-quota": {
      const payload = request.payload as StorageQuotaPayload;
      return { perms: ["nas:write"], scope: payload.scope };
    }
    case "password-reset":
    case "profile-update":
      // Own-identity actions confer no platform permission.
      return { perms: [], scope: "/" };
    default:
      return { perms: [], scope: "/" };
  }
}

/**
 * Can the requester run the underlying apply primitive THEMSELVES?
 *  - password-reset / profile-update: yes — own Authentik account.
 *  - app-access: only when within their own ceiling (they call
 *    applyRoleAssignments with their own granterPermsAt, which re-enforces it).
 *  - storage-quota: NO — the PVC patch is `cluster:admin`, which a self-request
 *    never carries, so it always queues even when `nas:write` is within ceiling.
 */
function isSelfExecutable(type: SelfServiceRequestType, withinCeiling: boolean): boolean {
  switch (type) {
    case "password-reset":
    case "profile-update":
      return true;
    case "app-access":
      return withinCeiling;
    case "storage-quota":
      return false;
    default:
      return false;
  }
}

export interface AutoApplyDecision {
  autoApply: boolean;
  /** Requested permissions the requester does NOT hold at the scope (empty ⇒ within ceiling). */
  beyond: Permission[];
  withinCeiling: boolean;
  selfExecutable: boolean;
  reason: string;
}

/**
 * Decide whether a submitted request auto-applies now or routes to approval.
 * Pure over `requesterCtx` — no I/O — so it is exhaustively unit-testable.
 */
export function evaluateAutoApply(requesterCtx: SessionRBACContext, request: SelfServiceRequest): AutoApplyDecision {
  const { perms, scope } = requestedPermsFor(request);
  const beyond = permissionsBeyondCeiling(requesterCtx, perms, scope);
  const withinCeiling = beyond.length === 0;
  const selfExecutable = isSelfExecutable(request.type, withinCeiling);
  const autoApply = withinCeiling && selfExecutable;

  const reason = autoApply
    ? "Within requester ceiling and self-executable — applied immediately"
    : !withinCeiling
      ? `Exceeds requester ceiling (${beyond.join(", ") || "beyond ceiling"}) — routed to approval`
      : "Primitive is admin-only — routed to approval";

  return { autoApply, beyond, withinCeiling, selfExecutable, reason };
}

/** A PVC the requester owns, with the storage scope its share maps to. */
export interface OwnedPvcRef {
  namespace: string;
  name: string;
  scope: string;
}

export type SubmitValidation = { ok: true } | { ok: false; status: number; error: string };

/**
 * Boundary check run BEFORE a request is queued or auto-applied. Its job is to
 * stop a requester submitting a storage-quota against a volume that is not
 * theirs: the target PVC must appear in the requester's OWN `nas_shares`, and the
 * requester must hold `nas:write` at that share's scope (a read-only share cannot
 * be expanded). Both together bound the submission to the requester's own PVCs
 * within ceiling — so they can never request quota on a stranger's volume even
 * though the apply itself always happens under an admin.
 *
 * Non-storage types have no target to forge here and pass through.
 */
export function validateSubmittable(
  requesterCtx: SessionRBACContext,
  request: SelfServiceRequest,
  ownedPvcs: OwnedPvcRef[],
): SubmitValidation {
  if (request.type === "profile-update") {
    // The value the requester writes is their own identity field — nothing to bound.
    const payload = request.payload as ProfileUpdatePayload;
    if (payload.field !== "name" && payload.field !== "email") {
      return { ok: false, status: 400, error: "Unsupported profile field" };
    }
    return { ok: true };
  }
  if (request.type !== "storage-quota") return { ok: true };

  const payload = request.payload as StorageQuotaPayload;
  const owned = ownedPvcs.find(
    (pvc) => pvc.namespace === payload.namespace && pvc.name === payload.pvcName,
  );
  if (!owned) {
    return { ok: false, status: 403, error: "You can only request quota on a volume assigned to you" };
  }
  // The share the PVC belongs to must be one the requester can write (ceiling).
  if (permissionsBeyondCeiling(requesterCtx, ["nas:write"], owned.scope).length > 0) {
    return { ok: false, status: 403, error: "You do not have write access to this volume's share" };
  }
  // The submitted scope must be the PVC's real scope, not an attacker-chosen one.
  if (payload.scope !== owned.scope) {
    return { ok: false, status: 400, error: "Scope does not match the target volume" };
  }
  return { ok: true };
}
