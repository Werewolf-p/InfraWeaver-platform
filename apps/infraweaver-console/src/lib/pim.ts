import type { Permission } from "@/lib/rbac";

/**
 * Azure-style access management + Privileged Identity Management (PIM) data model.
 *
 * This module is isomorphic (no server-only imports) so it can be shared between
 * server components, API routes, and client components. Persistence lives in a
 * Kubernetes ConfigMap (see access-store.ts); the shapes below describe the JSON
 * payloads stored under each ConfigMap key.
 */

export type PrincipalType = "user" | "group";

export type ResourceType = "app" | "game-server" | "hostname";

/** A role a user can *activate* just-in-time through PIM. */
export type PimRoleId =
  | "security-reader"
  | "security-admin"
  | "cluster-admin"
  | "rbac-admin"
  | "platform-updater";

export interface PimRoleDefinition {
  id: PimRoleId;
  name: string;
  description: string;
  permissions: Permission[];
  /** Hard ceiling on how long an activation may last (minutes). */
  maxDurationMinutes: number;
  color: "red" | "blue" | "green" | "purple" | "orange" | "teal";
}

export const PIM_ROLES: Record<PimRoleId, PimRoleDefinition> = {
  "security-reader": {
    id: "security-reader",
    name: "Security Reader",
    description: "Read secrets, certificates, and security posture (security:read).",
    permissions: ["security:read"],
    maxDurationMinutes: 240,
    color: "teal",
  },
  "security-admin": {
    id: "security-admin",
    name: "Security Admin",
    description: "Read and write secrets and security configuration.",
    permissions: ["security:read", "security:write"],
    maxDurationMinutes: 120,
    color: "red",
  },
  "cluster-admin": {
    id: "cluster-admin",
    name: "Cluster Admin",
    description: "Full cluster operations: drain, scale, and admin actions.",
    permissions: ["cluster:read", "cluster:drain", "cluster:scale", "cluster:admin"],
    maxDurationMinutes: 60,
    color: "purple",
  },
  "rbac-admin": {
    id: "rbac-admin",
    name: "RBAC Admin",
    description: "Manage role assignments and access policies (rbac:admin).",
    permissions: ["rbac:admin"],
    maxDurationMinutes: 120,
    color: "blue",
  },
  "platform-updater": {
    id: "platform-updater",
    name: "Platform Updater",
    description: "Commit platform/application version updates (platform:update).",
    permissions: ["platform:update"],
    maxDurationMinutes: 60,
    color: "orange",
  },
};

export const PIM_ROLE_IDS = Object.keys(PIM_ROLES) as PimRoleId[];

export function isPimRoleId(value: unknown): value is PimRoleId {
  return typeof value === "string" && value in PIM_ROLES;
}

/** Allowed activation durations surfaced in the UI (minutes). */
export const PIM_DURATION_OPTIONS = [30, 60, 240] as const;

/** A custom (Azure-style) group with its own permission set and members. */
export interface CustomGroup {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** Member identifiers — usernames or emails. */
  members: string[];
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
}

/** Grant a principal access to a specific resource. */
export interface ResourceAssignment {
  id: string;
  principalType: PrincipalType;
  /** username/email for users, group id for groups. */
  principalId: string;
  resourceType: ResourceType;
  /** app name, game-server name, or *.int.rlservers.com hostname. */
  resourceId: string;
  permissions: Permission[];
  grantedAt: string;
  grantedBy: string;
}

/** Declares who is *eligible* to activate a given PIM role. */
export interface PimEligibility {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  role: PimRoleId;
  /** Optional override of the role's max duration (minutes). */
  maxDurationMinutes?: number;
  createdAt: string;
  createdBy: string;
}

export type PimActivationStatus = "active" | "expired" | "deactivated";

/** A single just-in-time elevation, also serving as an audit-log entry. */
export interface PimActivation {
  id: string;
  user: string;
  role: PimRoleId;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  deactivatedAt?: string;
  deactivatedBy?: string;
}

export interface AccessControlState {
  groups: CustomGroup[];
  assignments: ResourceAssignment[];
  eligibility: PimEligibility[];
  activations: PimActivation[];
}

export const EMPTY_ACCESS_STATE: AccessControlState = {
  groups: [],
  assignments: [],
  eligibility: [],
  activations: [],
};

export function pimRolePermissions(role: PimRoleId): Permission[] {
  return PIM_ROLES[role]?.permissions ?? [];
}

export function effectiveMaxDuration(eligibility: PimEligibility): number {
  const roleMax = PIM_ROLES[eligibility.role]?.maxDurationMinutes ?? 60;
  if (!eligibility.maxDurationMinutes) return roleMax;
  return Math.min(eligibility.maxDurationMinutes, roleMax);
}

/**
 * Returns true if the activation is currently active (not deactivated and not
 * past its expiry). Fail-secure: anything unparseable counts as inactive.
 */
export function isActivationActive(activation: PimActivation, now: number = Date.now()): boolean {
  if (activation.deactivatedAt) return false;
  const expires = Date.parse(activation.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires > now;
}

export function activationStatus(activation: PimActivation, now: number = Date.now()): PimActivationStatus {
  if (activation.deactivatedAt) return "deactivated";
  return isActivationActive(activation, now) ? "active" : "expired";
}

export function activationRemainingMs(activation: PimActivation, now: number = Date.now()): number {
  const expires = Date.parse(activation.expiresAt);
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, expires - now);
}

/** Normalize an identity for comparison (case-insensitive, trimmed). */
export function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function identityMatches(principalId: string, identities: string[]): boolean {
  const target = normalizeIdentity(principalId);
  return identities.some((id) => normalizeIdentity(id) === target);
}

/**
 * Compute the set of additional permissions a user gains from:
 *  - membership in custom groups
 *  - currently-active (non-expired) PIM elevations
 *
 * `identities` should include every identifier that may name the user
 * (e.g. username and email). Group membership is also expanded through the
 * user's Authentik groups so that group-scoped PIM eligibility and custom
 * groups whose id/name matches an Authentik group are honored.
 */
export function computeExtraPermissions(
  state: AccessControlState,
  identities: string[],
  authentikGroups: string[] = [],
  now: number = Date.now(),
): Set<Permission> {
  const perms = new Set<Permission>();
  const userIds = identities.filter(Boolean);
  const groupIds = new Set<string>();

  // Custom group membership grants the group's permissions.
  for (const group of state.groups) {
    const isMember =
      group.members.some((member) => identityMatches(member, userIds)) ||
      authentikGroups.some(
        (g) =>
          normalizeIdentity(g) === normalizeIdentity(group.id) ||
          normalizeIdentity(g) === normalizeIdentity(group.name),
      );
    if (isMember) {
      groupIds.add(group.id);
      for (const permission of group.permissions) perms.add(permission);
    }
  }

  // Active PIM elevations grant the role's permissions.
  for (const activation of state.activations) {
    if (!isActivationActive(activation, now)) continue;
    if (!identityMatches(activation.user, userIds)) continue;
    for (const permission of pimRolePermissions(activation.role)) perms.add(permission);
  }

  return perms;
}

/**
 * Returns the PIM roles a user is eligible to activate, considering both direct
 * (user) eligibility and group eligibility (via Authentik groups or custom group
 * membership).
 */
export function eligibleRolesFor(
  state: AccessControlState,
  identities: string[],
  authentikGroups: string[] = [],
): PimEligibility[] {
  const userIds = identities.filter(Boolean);
  const memberGroupIds = new Set<string>(
    state.groups
      .filter((group) => group.members.some((member) => identityMatches(member, userIds)))
      .map((group) => group.id),
  );
  const groupNames = new Set<string>([
    ...authentikGroups.map((g) => normalizeIdentity(g)),
    ...[...memberGroupIds].map((id) => normalizeIdentity(id)),
    ...state.groups
      .filter((group) => memberGroupIds.has(group.id))
      .map((group) => normalizeIdentity(group.name)),
  ]);

  return state.eligibility.filter((entry) => {
    if (entry.principalType === "user") return identityMatches(entry.principalId, userIds);
    return groupNames.has(normalizeIdentity(entry.principalId)) || memberGroupIds.has(entry.principalId);
  });
}
