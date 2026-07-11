import {
  ALL_PERMISSIONS,
  expandPermissionPattern,
  resolveRoleDefinition,
  scopeCovers,
  scopeLabel,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { EXPIRING_SOON_MS } from "@/lib/rbac-access-matrix";

/**
 * Pure model behind the settings/rbac "effective access preview".
 *
 * The editor stages edits client-side (grants to add, existing-assignment ids to
 * revoke) and only writes them on Apply. This module answers, for every principal
 * a staged edit touches, "what will they actually be able to do once you click
 * Apply?" — a humanized, Azure-style read-out that folds in the principal's other
 * existing grants and honors Deny and expiry the same way the enforcing resolver
 * (`getEffectivePermissions`) does. Kept side-effect free so it unit-tests cleanly
 * and the UI is a thin renderer over it.
 */

export type RightTone = "allow" | "deny";

/** One humanized capability line, e.g. { label: "Manage game servers", tone: "allow" }. */
export interface HumanRight {
  /** Stable, unique key for React list + motion identity. */
  key: string;
  label: string;
  tone: RightTone;
  /** Set on Deny lines so the "where" is explicit, e.g. "Server: foo". */
  scopeLabel?: string;
}

export type GrantState = "existing" | "added" | "removed";

/** A grant row in the post-apply picture, tagged with how staging changes it. */
export interface PreviewGrant {
  key: string;
  roleId: string;
  roleName: string;
  scope: string;
  scopeLabel: string;
  effect: "Allow" | "Deny";
  expiresAt?: string;
  expiringSoon: boolean;
  state: GrantState;
}

export type NetChange = "gain" | "loss" | "mixed" | "none";

export interface PrincipalPreview {
  /** `${principalType}:${principal}` — matches how the editor batches per principal. */
  key: string;
  principalType: "user" | "group";
  principal: string;
  principalLabel: string;
  /** Allow lines first, then Deny lines. */
  rights: HumanRight[];
  grants: PreviewGrant[];
  /** Any surviving grant carries an expiry. */
  hasExpiry: boolean;
  /** Any surviving grant expires within EXPIRING_SOON_MS. */
  expiringSoon: boolean;
  net: NetChange;
}

/** An existing assignment carrying the editor's principal handle + display label. */
export interface PreviewAssignment extends RoleAssignment {
  /** Principal handle the editor keys revokes on (username for users, group name for groups). */
  principal: string;
  principalLabel: string;
}

/** A grant staged in the editor, not yet written. Always an Allow at its scope. */
export interface StagedGrantInput {
  principalType: "user" | "group";
  principal: string;
  principalLabel: string;
  roleId: string;
  scope: string;
}

export interface EffectivePreviewInput {
  assignments: PreviewAssignment[];
  pendingGrants: StagedGrantInput[];
  revokedIds: Iterable<string>;
  /** Injectable clock so tests are deterministic; defaults to now. */
  now?: number;
}

// ─── Humanization ───────────────────────────────────────────────────────────

/** resource prefix (before the first ":") → friendly noun used in right lines. */
const RESOURCE_NOUN: Record<string, string> = {
  apps: "apps",
  config: "configuration",
  catalog: "the catalog",
  users: "users",
  cluster: "the cluster",
  security: "security settings",
  nas: "NAS storage",
  infra: "infrastructure",
  rbac: "access control (RBAC)",
  platform: "the platform",
  "game-hub": "game servers",
  wiki: "the wiki",
  wordpress: "WordPress sites",
  jellyfin: "Jellyfin",
};

function resourceOf(permission: string): string {
  const separator = permission.indexOf(":");
  return separator === -1 ? permission : permission.slice(0, separator);
}

function verbOf(permission: string): string {
  const separator = permission.indexOf(":");
  return separator === -1 ? permission : permission.slice(separator + 1);
}

function nounFor(resource: string): string {
  return RESOURCE_NOUN[resource] ?? resource;
}

/** A verb beyond plain read means the holder can change, not merely view, the resource. */
function isMutatingVerb(verb: string): boolean {
  return verb !== "read";
}

/**
 * Collapses a set of concrete permissions into one capability line per resource:
 * "Manage X" when any mutating verb is present, else "View X". The owner wildcard
 * short-circuits to a single full-access line.
 */
export function humanizePermissions(permissions: Iterable<Permission | "*">): HumanRight[] {
  const perms = new Set<string>(permissions);
  if (perms.has("*")) {
    return [{ key: "allow:owner", label: "Full owner access — every resource", tone: "allow" }];
  }
  return summarizeByResource(perms, "allow");
}

/**
 * Groups concrete permissions by resource into Manage/View lines. `scope`, when
 * given, tags each line (used for Deny lines so "cannot X, where" is explicit)
 * and is folded into the key so the same denial on two scopes stays distinct.
 */
function summarizeByResource(permissions: Iterable<string>, tone: RightTone, scope?: string): HumanRight[] {
  const mutatingByResource = new Map<string, boolean>();
  for (const permission of permissions) {
    if (permission === "*") continue;
    const resource = resourceOf(permission);
    const wasMutating = mutatingByResource.get(resource) ?? false;
    mutatingByResource.set(resource, wasMutating || isMutatingVerb(verbOf(permission)));
  }

  const rights: HumanRight[] = [];
  for (const [resource, mutating] of mutatingByResource) {
    const noun = nounFor(resource);
    const label =
      tone === "deny"
        ? `Cannot ${mutating ? "manage" : "view"} ${noun}`
        : `${mutating ? "Manage" : "View"} ${noun}`;
    rights.push({
      key: `${tone}:${resource}${scope ? `@${scope}` : ""}`,
      label,
      tone,
      ...(scope ? { scopeLabel: scopeLabel(scope) } : {}),
    });
  }
  rights.sort((a, b) => a.label.localeCompare(b.label));
  return rights;
}

// ─── Effective computation ──────────────────────────────────────────────────

function isExpired(assignment: { expiresAt?: string }, now: number): boolean {
  if (!assignment.expiresAt) return false;
  const ms = Date.parse(assignment.expiresAt);
  return Number.isFinite(ms) && ms < now;
}

function isExpiringSoon(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms - now > 0 && ms - now <= EXPIRING_SOON_MS;
}

/** Expands a granted pattern to the concrete permissions it confers ("*" → all). */
function expandGranted(pattern: string): Permission[] {
  if (pattern === "*") return ALL_PERMISSIONS.filter((p) => p !== "*");
  return expandPermissionPattern(pattern);
}

type MinimalAssignment = { roleId: string; scope: string; effect?: "Allow" | "Deny"; expiresAt?: string };

interface EffectiveShape {
  /** Raw allow patterns as authored on the covering roles (keeps "*" for owner). */
  allowPatterns: Set<string>;
  /** Concrete permissions denied by covering Deny/notActions AT this scope. */
  denyConcrete: Set<Permission>;
}

/**
 * Allow/deny shape at ONE evaluation scope, honoring inheritance exactly as the
 * enforcing resolver does: only assignments whose scope COVERS `evalScope`
 * apply, and a Deny only subtracts where it covers. A Deny scoped to one server
 * therefore never strips a principal's cluster-wide grants.
 */
function shapeAtScope(assignments: MinimalAssignment[], evalScope: string, now: number): EffectiveShape {
  const allowPatterns = new Set<string>();
  const denyConcrete = new Set<Permission>();
  for (const assignment of assignments) {
    if (isExpired(assignment, now)) continue;
    if (!scopeCovers(assignment.scope, evalScope)) continue;
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) continue;
    if (assignment.effect === "Deny") {
      for (const pattern of role.permissions) for (const concrete of expandGranted(pattern)) denyConcrete.add(concrete);
    } else {
      for (const pattern of role.permissions) allowPatterns.add(pattern);
    }
    if (role.notActions) {
      for (const pattern of role.notActions) for (const concrete of expandGranted(pattern)) denyConcrete.add(concrete);
    }
  }
  return { allowPatterns, denyConcrete };
}

/** Concrete allow at one scope = expand(allow patterns) − deny. */
function concreteAtScope(shape: EffectiveShape): Set<Permission> {
  const allow = new Set<Permission>();
  for (const pattern of shape.allowPatterns) for (const concrete of expandGranted(pattern)) allow.add(concrete);
  for (const denied of shape.denyConcrete) allow.delete(denied);
  return allow;
}

function isOwnerAtScope(shape: EffectiveShape): boolean {
  return shape.allowPatterns.has("*") && shape.denyConcrete.size === 0;
}

/**
 * A principal's effective concrete permissions, unioned across every scope they
 * hold a grant on (plus root). "Somewhere they can do X" — the honest summary of
 * a scope-inheriting model — with a flag when any scope confers full ownership.
 */
function effectiveConcrete(assignments: MinimalAssignment[], now: number): { concrete: Set<Permission>; owner: boolean } {
  const scopes = new Set<string>(["/"]);
  for (const assignment of assignments) scopes.add(assignment.scope);
  const concrete = new Set<Permission>();
  let owner = false;
  for (const scope of scopes) {
    const shape = shapeAtScope(assignments, scope, now);
    if (isOwnerAtScope(shape)) owner = true;
    for (const permission of concreteAtScope(shape)) concrete.add(permission);
  }
  return { concrete, owner };
}

function allowRights(effective: { concrete: Set<Permission>; owner: boolean }): HumanRight[] {
  if (effective.owner) {
    return [{ key: "allow:owner", label: "Full owner access — every resource", tone: "allow" }];
  }
  return humanizePermissions(effective.concrete);
}

/** One "Cannot …" line per resource per Deny grant, so the scope of each denial is explicit. */
function denyRights(assignments: Array<{ roleId: string; scope: string; effect?: "Allow" | "Deny"; expiresAt?: string }>, now: number): HumanRight[] {
  const byKey = new Map<string, HumanRight>();
  for (const assignment of assignments) {
    if (assignment.effect !== "Deny" || isExpired(assignment, now)) continue;
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) continue;
    const concrete = role.permissions.flatMap(expandGranted);
    for (const right of summarizeByResource(concrete, "deny", assignment.scope)) byKey.set(right.key, right);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function netChange(before: Set<Permission>, after: Set<Permission>): NetChange {
  let added = false;
  let removed = false;
  for (const permission of after) if (!before.has(permission)) added = true;
  for (const permission of before) if (!after.has(permission)) removed = true;
  if (added && removed) return "mixed";
  if (added) return "gain";
  if (removed) return "loss";
  return "none";
}

interface Bucket {
  principalType: "user" | "group";
  principal: string;
  principalLabel: string;
  /** All of the principal's current assignments, untouched. */
  current: PreviewAssignment[];
  /** Ids among `current` marked for removal. */
  revokedIds: Set<string>;
  /** Grants staged to be added. */
  added: StagedGrantInput[];
}

export function computeEffectivePreview(input: EffectivePreviewInput): PrincipalPreview[] {
  const now = input.now ?? Date.now();
  const revoked = new Set(input.revokedIds);

  const buckets = new Map<string, Bucket>();
  const bucketFor = (principalType: "user" | "group", principal: string, principalLabel: string): Bucket => {
    const key = `${principalType}:${principal}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { principalType, principal, principalLabel, current: [], revokedIds: new Set(), added: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  // Index every existing assignment under its principal.
  for (const assignment of input.assignments) {
    const bucket = bucketFor(assignment.principalType, assignment.principal, assignment.principalLabel);
    bucket.current.push(assignment);
    if (revoked.has(assignment.id)) bucket.revokedIds.add(assignment.id);
  }
  // Fold in staged additions.
  for (const grant of input.pendingGrants) {
    bucketFor(grant.principalType, grant.principal, grant.principalLabel).added.push(grant);
  }

  const previews: PrincipalPreview[] = [];
  for (const [key, bucket] of buckets) {
    const touched = bucket.revokedIds.size > 0 || bucket.added.length > 0;
    if (!touched) continue;

    // Before = every current grant; After = surviving current grants + staged additions.
    const beforeAssignments = bucket.current;
    const surviving = bucket.current.filter((a) => !bucket.revokedIds.has(a.id));
    const stagedAsAssignments = bucket.added.map((g) => ({ roleId: g.roleId, scope: g.scope, effect: "Allow" as const }));
    const afterAssignments = [...surviving, ...stagedAsAssignments];

    const before = effectiveConcrete(beforeAssignments, now).concrete;
    const afterEffective = effectiveConcrete(afterAssignments, now);
    const after = afterEffective.concrete;

    const rights = [...allowRights(afterEffective), ...denyRights(afterAssignments, now)];

    const grants: PreviewGrant[] = [];
    for (const assignment of bucket.current) {
      const role = resolveRoleDefinition(assignment.roleId);
      grants.push({
        key: `g:${assignment.id}`,
        roleId: assignment.roleId,
        roleName: role?.name ?? assignment.roleId,
        scope: assignment.scope,
        scopeLabel: scopeLabel(assignment.scope),
        effect: assignment.effect === "Deny" ? "Deny" : "Allow",
        expiresAt: assignment.expiresAt,
        expiringSoon: isExpiringSoon(assignment.expiresAt, now),
        state: bucket.revokedIds.has(assignment.id) ? "removed" : "existing",
      });
    }
    bucket.added.forEach((grant, index) => {
      const role = resolveRoleDefinition(grant.roleId);
      grants.push({
        key: `add:${key}:${index}:${grant.roleId}:${grant.scope}`,
        roleId: grant.roleId,
        roleName: role?.name ?? grant.roleId,
        scope: grant.scope,
        scopeLabel: scopeLabel(grant.scope),
        effect: "Allow",
        expiringSoon: false,
        state: "added",
      });
    });

    const surviteGrants = grants.filter((g) => g.state !== "removed");
    const hasExpiry = surviteGrants.some((g) => Boolean(g.expiresAt) && !isExpired({ expiresAt: g.expiresAt }, now));
    const expiringSoon = surviteGrants.some((g) => g.expiringSoon);

    previews.push({
      key,
      principalType: bucket.principalType,
      principal: bucket.principal,
      principalLabel: bucket.principalLabel,
      rights,
      grants,
      hasExpiry,
      expiringSoon,
      net: netChange(before, after),
    });
  }

  previews.sort((a, b) => a.principalLabel.localeCompare(b.principalLabel));
  return previews;
}
