import {
  isAssignmentExpired,
  isStrictAncestorScope,
  resolveRoleDefinition,
  scopeCovers,
  scopeLabel,
  type RoleAssignment,
  type RoleDefinition,
} from "@/lib/rbac";

/**
 * Pure aggregation for the RBAC access surface ("who has access to what, where").
 *
 * These functions take already-gathered grants (from users.yaml + the access
 * ConfigMap) and shape them for the access-matrix / scope-access views. They are
 * isomorphic and side-effect free so they can be unit-tested directly; the impure
 * gathering lives in `rbac-matrix-source.ts`.
 */

export type AssignmentEffect = "Allow" | "Deny";
export type MatrixPrincipalType = "user" | "group" | "serviceAccount";
export type RoleColor = NonNullable<RoleDefinition["color"]>;

/** A single grant attached to a principal, before role-metadata resolution. */
export interface MatrixGrant {
  roleId: string;
  scope: string;
  effect: AssignmentEffect;
  expiresAt?: string;
  /** Human origin, e.g. "Direct", "Group: platform-admins", "PIM (active)". */
  source: string;
  /** Display name for non-built-in roles (PIM roles, custom groups). */
  roleName?: string;
  color?: RoleColor;
}

export interface MatrixPrincipal {
  principalId: string;
  principalType: MatrixPrincipalType;
  displayName: string;
  secondary?: string;
  grants: MatrixGrant[];
}

/** A resolved matrix cell (one grant with presentation + validity metadata). */
export interface AccessMatrixCell {
  scope: string;
  scopeLabel: string;
  roleId: string;
  roleName: string;
  color: RoleColor;
  effect: AssignmentEffect;
  expiresAt?: string;
  source: string;
  /** roleId does not resolve to a known role (deleted/renamed) — surfaced in red. */
  orphaned: boolean;
  /** expires within EXPIRING_SOON_MS from `now`. */
  expiringSoon: boolean;
}

export interface AccessMatrixPrincipal {
  principalId: string;
  principalType: MatrixPrincipalType;
  displayName: string;
  secondary?: string;
  cells: AccessMatrixCell[];
  /** Distinct scopes this principal holds any grant on. */
  scopes: string[];
}

export interface AccessMatrix {
  principals: AccessMatrixPrincipal[];
  /** Union of every scope across principals, sorted for stable columns. */
  scopes: string[];
}

/** Grants expiring within 7 days are flagged "expiring soon". */
export const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_COLOR: RoleColor = "gray";

function resolveCell(grant: MatrixGrant, now: number): AccessMatrixCell {
  const role = resolveRoleDefinition(grant.roleId);
  const orphaned = !role && !grant.roleName;
  const expiresMs = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
  const expiringSoon = Number.isFinite(expiresMs) && expiresMs - now > 0 && expiresMs - now <= EXPIRING_SOON_MS;
  return {
    scope: grant.scope,
    scopeLabel: scopeLabel(grant.scope),
    roleId: grant.roleId,
    roleName: role?.name ?? grant.roleName ?? grant.roleId,
    color: grant.color ?? role?.color ?? DEFAULT_COLOR,
    effect: grant.effect,
    expiresAt: grant.expiresAt,
    source: grant.source,
    orphaned,
    expiringSoon,
  };
}

/** Builds the principals × scopes access matrix from gathered grants. */
export function buildAccessMatrix(principals: MatrixPrincipal[], now: number = Date.now()): AccessMatrix {
  const allScopes = new Set<string>();
  const resolved: AccessMatrixPrincipal[] = principals.map((principal) => {
    const cells = principal.grants.map((grant) => resolveCell(grant, now));
    const scopes = [...new Set(cells.map((cell) => cell.scope))].sort(scopeSort);
    for (const scope of scopes) allScopes.add(scope);
    return {
      principalId: principal.principalId,
      principalType: principal.principalType,
      displayName: principal.displayName,
      secondary: principal.secondary,
      cells,
      scopes,
    };
  });
  resolved.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { principals: resolved, scopes: [...allScopes].sort(scopeSort) };
}

/** One principal's access on a queried scope, direct or inherited from an ancestor. */
export interface ScopeAccessEntry {
  principalId: string;
  principalType: MatrixPrincipalType;
  displayName: string;
  secondary?: string;
  roleId: string;
  roleName: string;
  color: RoleColor;
  effect: AssignmentEffect;
  /** The scope the grant was actually made on. */
  sourceScope: string;
  sourceScopeLabel: string;
  /** True when sourceScope is a strict ancestor of the queried scope. */
  inherited: boolean;
  expiresAt?: string;
  source: string;
  orphaned: boolean;
}

/**
 * Scope-first "who has access here": every principal with a direct or inherited
 * (ancestor-scope) grant on `scope`, expired grants excluded.
 */
export function buildScopeAccess(principals: MatrixPrincipal[], scope: string, now: number = Date.now()): ScopeAccessEntry[] {
  const entries: ScopeAccessEntry[] = [];
  for (const principal of principals) {
    for (const grant of principal.grants) {
      if (isGrantExpired(grant, now)) continue;
      if (!scopeCovers(grant.scope, scope)) continue;
      const role = resolveRoleDefinition(grant.roleId);
      entries.push({
        principalId: principal.principalId,
        principalType: principal.principalType,
        displayName: principal.displayName,
        secondary: principal.secondary,
        roleId: grant.roleId,
        roleName: role?.name ?? grant.roleName ?? grant.roleId,
        color: grant.color ?? role?.color ?? DEFAULT_COLOR,
        effect: grant.effect,
        sourceScope: grant.scope,
        sourceScopeLabel: scopeLabel(grant.scope),
        inherited: isStrictAncestorScope(grant.scope, scope),
        expiresAt: grant.expiresAt,
        source: grant.source,
        orphaned: !role && !grant.roleName,
      });
    }
  }
  // Direct grants first, then inherited; then by principal name.
  entries.sort((a, b) => Number(a.inherited) - Number(b.inherited) || a.displayName.localeCompare(b.displayName));
  return entries;
}

/** Converts a principal's grants into RoleAssignment[] for the permission resolver. */
export function grantsToAssignments(principal: MatrixPrincipal): RoleAssignment[] {
  return principal.grants.map((grant, index) => ({
    id: `${principal.principalId}:${index}`,
    roleId: grant.roleId,
    scope: grant.scope,
    principalType: principal.principalType === "group" ? "group" : "user",
    principalId: principal.principalId,
    grantedBy: grant.source,
    grantedAt: new Date(0).toISOString(),
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.effect === "Deny" ? { effect: "Deny" as const } : {}),
  }));
}

function isGrantExpired(grant: MatrixGrant, now: number): boolean {
  if (!grant.expiresAt) return false;
  const ms = Date.parse(grant.expiresAt);
  return Number.isFinite(ms) && ms < now;
}

/** Root first, then lexicographic — keeps "/" as the leftmost column. */
function scopeSort(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "/") return -1;
  if (b === "/") return 1;
  return a.localeCompare(b);
}

export { isAssignmentExpired };
