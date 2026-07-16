import { resolveRoleDefinition, scopeLabel } from "@/lib/rbac";
import { describeNasScope } from "@/lib/nas/scope";
import type {
  AppAccessPayload,
  ProfileUpdatePayload,
  SelfServiceRequest,
  SelfServiceRequestType,
  StorageQuotaPayload,
} from "./types";

/**
 * Human-readable request/ceiling-preview labels. Client-safe (no server-only) so
 * the request cards, My Requests list, and the notify emails all render the same
 * wording. `resolveRoleDefinition`, `scopeLabel`, `describeNasScope` are all pure.
 */

const TYPE_LABELS: Record<SelfServiceRequestType, string> = {
  "app-access": "App access",
  "storage-quota": "Storage quota",
  "password-reset": "Password reset",
  "profile-update": "Profile update",
};

export function requestTypeLabel(type: SelfServiceRequestType): string {
  return TYPE_LABELS[type];
}

function roleLabel(roleId: string): string {
  return resolveRoleDefinition(roleId)?.name ?? roleId;
}

/** One-line summary of what a request asks for. */
export function describeRequest(request: SelfServiceRequest): string {
  switch (request.type) {
    case "app-access": {
      const payload = request.payload as AppAccessPayload;
      return `Requests ${roleLabel(payload.roleId)} at ${scopeLabel(payload.scope)}`;
    }
    case "storage-quota": {
      const payload = request.payload as StorageQuotaPayload;
      const from = payload.currentSize ? `${payload.currentSize} → ` : "";
      return `Expand ${describeNasScope(payload.scope)} (${payload.namespace}/${payload.pvcName}) to ${from}${payload.requestedSize}`;
    }
    case "password-reset":
      return "Reset password (own account)";
    case "profile-update": {
      const payload = request.payload as ProfileUpdatePayload;
      return `Update ${payload.field} to "${payload.value}"`;
    }
    default:
      return "Self-service request";
  }
}

/**
 * The exact effect an admin approval will commit, for the approval-queue preview.
 * Deliberately concrete ("this grants role X at scope Y" / "expands PVC to Z") so
 * the admin sees the outcome before they commit.
 */
export function describeCeilingEffect(request: SelfServiceRequest): string {
  switch (request.type) {
    case "app-access": {
      const payload = request.payload as AppAccessPayload;
      const expiry = payload.expiresAt ? ` (expires ${new Date(payload.expiresAt).toLocaleString()})` : "";
      return `Grants ${roleLabel(payload.roleId)} at ${scopeLabel(payload.scope)}${expiry}`;
    }
    case "storage-quota": {
      const payload = request.payload as StorageQuotaPayload;
      return `Expands PVC ${payload.namespace}/${payload.pvcName} to ${payload.requestedSize}`;
    }
    case "password-reset":
      return "Issues a password recovery link to the requester's email";
    case "profile-update": {
      const payload = request.payload as ProfileUpdatePayload;
      return `Sets the requester's ${payload.field} to "${payload.value}"`;
    }
    default:
      return describeRequest(request);
  }
}
