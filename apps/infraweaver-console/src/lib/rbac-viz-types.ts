import type { PermissionPattern, RoleDefinition } from "@/lib/rbac";

export type SubjectKind = "User" | "Group" | "ServiceAccount";

export type RoleColor = NonNullable<RoleDefinition["color"]>;

/**
 * A single resolved role binding for a subject: the concrete role, the scope it
 * applies to, the permissions it confers, and where the binding came from
 * (the user's group membership, a direct role assignment, or — for service
 * accounts — a Kubernetes ClusterRoleBinding).
 */
export interface SubjectBinding {
  roleId: string;
  roleName: string;
  scope: string;
  scopeLabel: string;
  permissions: PermissionPattern[];
  color?: RoleColor;
  /** Human-readable origin, e.g. "Group: platform-admins" or "Direct assignment". */
  sourceLabel: string;
  expiresAt?: string;
}

/** A platform principal (user or group) resolved from users.yaml. */
export interface PlatformSubject {
  id: string;
  kind: "User" | "Group";
  name: string;
  /** Email (users) or "N members" summary (groups). */
  secondary?: string;
  /** Group memberships for a user, or member usernames for a group. */
  related: string[];
  bindings: SubjectBinding[];
  /** Union of every permission the bindings confer. */
  permissions: PermissionPattern[];
}

export interface PlatformSubjectsResponse {
  users: PlatformSubject[];
  groups: PlatformSubject[];
}
