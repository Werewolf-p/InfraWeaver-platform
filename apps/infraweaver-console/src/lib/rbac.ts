/**
 * Runtime registry of every permission. The `Permission` union is DERIVED from
 * this list, so adding an entry here is the single source of truth — no
 * hand-maintained union to keep in sync.
 */
export const ALL_PERMISSIONS = [
  "*",
  "apps:read", "apps:write", "apps:sync", "apps:delete",
  "config:read", "config:write",
  "catalog:write", "catalog:delete",
  "users:read", "users:write", "users:invite",
  "cluster:read", "cluster:drain", "cluster:scale", "cluster:admin",
  "security:read", "security:write",
  "nas:read", "nas:write",
  "infra:read", "infra:write", "rbac:admin",
  "platform:update",
  "game-hub:read", "game-hub:write", "game-hub:admin",
  "game-hub:players",
  "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop", "game-hub:scale",
  "wiki:read", "wiki:edit",
  "wordpress:read", "wordpress:write", "wordpress:admin",
  "jellyfin:read", "jellyfin:admin",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/**
 * A grantable permission on the ROLE (granted) side. In addition to concrete
 * `Permission` values, a role may hold action/prefix wildcards so custom or
 * admin roles need not enumerate every verb:
 *   - `"*"`            — all permissions (Owner)
 *   - `"<resource>:*"` — every verb of a resource (e.g. `game-hub:*`)
 *   - `"*:<verb>"`     — a verb across every resource (e.g. `*:read`)
 * REQUESTED actions stay the concrete `Permission` union; only the granted side
 * is widened. See {@link permissionMatches} / {@link expandPermissionPattern}.
 */
export type PermissionPattern = Permission | `${string}:*` | `*:${string}`;

const CONCRETE_PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

/** True if `value` is a concrete member of the `Permission` union. */
export function isConcretePermission(value: string): value is Permission {
  return CONCRETE_PERMISSION_SET.has(value);
}

/**
 * Deny-list of permissions a custom group may NOT contain. Deny-list (not
 * allow-list) chosen deliberately: new resource-level permissions (apps:*,
 * game-hub:*, wiki:*, *:read, etc.) should be groupable by default, so only the
 * platform-level escalation tier needs explicit listing here. This stops an
 * rbac:admin/cluster:admin holder — including a time-boxed PIM cluster-admin —
 * from minting a *permanent* platform-level grant by authoring a custom group
 * (see pim.ts computeExtraPermissions, which folds group perms in cluster-wide).
 */
export const GROUP_DENIED_PERMISSIONS = [
  "*",
  "users:write",
  "users:invite",
  "rbac:admin",
  "platform:update",
  "cluster:admin",
  // cluster:drain / cluster:scale are PIM-time-boxed cluster operations (pim.ts
  // cluster-admin role); a custom group must not carry them or a 60-minute
  // elevation could mint itself permanent cluster-operation rights.
  "cluster:drain",
  "cluster:scale",
  "security:write",
] as const satisfies readonly Permission[];

const GROUP_DENIED_PERMISSION_SET = new Set<Permission>(GROUP_DENIED_PERMISSIONS);

/** True if `permission` is allowed to appear in a custom group's permission set. */
export function isGroupAllowedPermission(permission: Permission): boolean {
  return !GROUP_DENIED_PERMISSION_SET.has(permission);
}

export type BuiltInRoleId =
  // Azure-style generic scope roles — a small fixed set assignable at ANY scope
  // in the hierarchy, inheriting downward (see scopeCovers / isAllowed).
  | "owner"
  | "admin"
  | "editor"
  | "reader"
  | "platform-owner"
  | "platform-admin"
  | "platform-operator"
  | "platform-viewer"
  | "viewer"
  | "ops"
  | "developer"
  | "readonly-infra"
  | "game-server-admin"
  | "game-server-operator"
  | "game-server-viewer"
  | "game-hub-player"
  | "wiki-viewer"
  | "wiki-editor"
  | "wordpress-admin"
  | "wordpress-editor"
  | "wordpress-viewer"
  | "storage-viewer"
  | "storage-contributor"
  | "jellyfin-user"
  | "jellyfin-admin"
  | "support";

export type RoleId = BuiltInRoleId | string;

export interface RoleDefinition {
  id: RoleId;
  name: string;
  description: string;
  /** Granted permissions — concrete or wildcard patterns (see PermissionPattern). */
  permissions: PermissionPattern[];
  /**
   * Azure-style deny list: permissions this role explicitly withholds even when
   * `permissions` (or a wildcard) would otherwise grant them. notActions always
   * subtract and win over the role's own allows.
   */
  notActions?: Permission[];
  isBuiltIn: boolean;
  category?: "scoped" | "platform" | "game-hub" | "wiki" | "wordpress" | "storage" | "jellyfin";
  color?: "red" | "blue" | "green" | "purple" | "orange" | "yellow" | "teal" | "gray";
}

export interface RoleAssignment {
  id: string;
  roleId: RoleId;
  scope: string;
  principalType: "user" | "group";
  principalId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  conditions?: string;
  /**
   * Azure-style assignment effect. Defaults to "Allow". A "Deny" assignment
   * removes its role's permissions from the principal at (and below) its scope
   * and wins over any Allow. Absent === "Allow" for full back-compat.
   */
  effect?: "Allow" | "Deny";
}

/**
 * Azure-style generic scope roles. The platform deliberately keeps a SMALL fixed
 * set of roles that can be assigned at any scope in the hierarchy and inherit
 * downward (platform → resource group → resource; see scopeCovers / isAllowed):
 *
 *   Reader  – view resources within the scope
 *   Editor  – Reader + create/modify/operate resources (Azure "Contributor")
 *   Admin   – Editor + full management of the resource type (delete, *:admin)
 *   Owner   – full control, including managing access ("*")
 *
 * Reader/Editor/Admin are RESOURCE-tier: their permission sets are derived from
 * the permission registry and NEVER include the platform-escalation tier
 * (GROUP_DENIED_PERMISSIONS), so a scoped Admin can never mint users:write /
 * rbac:admin / cluster:admin. Owner is the single full-control role ("*").
 */
export function permissionVerb(permission: string): string {
  const separator = permission.indexOf(":");
  return separator === -1 ? permission : permission.slice(separator + 1);
}

/**
 * True if a GRANTED permission (concrete or wildcard) satisfies a concrete
 * REQUESTED permission. Supports `"*"`, `"<resource>:*"`, and `"*:<verb>"`.
 * Boundary-aware on the `:` separator so `game-hub:*` never matches
 * `game-hub-other:read`.
 */
export function permissionMatches(granted: string, requested: Permission): boolean {
  if (granted === "*") return true;
  if (granted === requested) return true;
  if (granted.endsWith(":*")) return requested.startsWith(granted.slice(0, -1));
  if (granted.startsWith("*:")) return permissionVerb(requested) === granted.slice(2);
  return false;
}

/**
 * Expands a granted permission (concrete or wildcard) into the concrete
 * `Permission` values it confers. `"*"` is preserved as the wildcard token so
 * Owner semantics are unchanged; a concrete permission expands to itself; an
 * unknown/malformed token expands to nothing (grants no access).
 */
export function expandPermissionPattern(pattern: string): Permission[] {
  if (pattern === "*") return ["*"];
  if (isConcretePermission(pattern)) return [pattern];
  if (pattern.endsWith(":*") || pattern.startsWith("*:")) {
    return ALL_PERMISSIONS.filter((p) => p !== "*" && permissionMatches(pattern, p));
  }
  return [];
}

/** Like {@link expandPermissionPattern} but `"*"` fans out to every concrete permission. */
export function expandToConcrete(pattern: string): Permission[] {
  if (pattern === "*") return ALL_PERMISSIONS.filter((p) => p !== "*");
  return expandPermissionPattern(pattern);
}

const READER_VERBS: ReadonlySet<string> = new Set(["read"]);
const EDITOR_VERBS: ReadonlySet<string> = new Set([
  "read", "write", "edit", "sync", "start", "stop", "scale", "console", "files", "players",
]);

/** Resource-tier permissions = everything assignable except the escalation tier. */
const RESOURCE_TIER_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (permission) => permission !== "*" && isGroupAllowedPermission(permission),
);
const READER_PERMISSIONS: Permission[] = RESOURCE_TIER_PERMISSIONS.filter((p) => READER_VERBS.has(permissionVerb(p)));
const EDITOR_PERMISSIONS: Permission[] = RESOURCE_TIER_PERMISSIONS.filter((p) => EDITOR_VERBS.has(permissionVerb(p)));
const ADMIN_PERMISSIONS: Permission[] = [...RESOURCE_TIER_PERMISSIONS];

export const BUILT_IN_ROLES: Record<BuiltInRoleId, RoleDefinition> = {
  owner: {
    id: "owner",
    name: "Owner",
    description: "Full control within the assigned scope, including managing access. Inherits to all child scopes.",
    permissions: ["*"],
    isBuiltIn: true,
    category: "scoped",
    color: "red",
  },
  admin: {
    id: "admin",
    name: "Admin",
    description: "Full management of every resource within the assigned scope (create, modify, delete). Inherits to all child scopes.",
    permissions: ADMIN_PERMISSIONS,
    isBuiltIn: true,
    category: "scoped",
    color: "purple",
  },
  editor: {
    id: "editor",
    name: "Editor",
    description: "Create, modify, and operate resources within the assigned scope. Inherits to all child scopes.",
    permissions: EDITOR_PERMISSIONS,
    isBuiltIn: true,
    category: "scoped",
    color: "blue",
  },
  reader: {
    id: "reader",
    name: "Reader",
    description: "Read-only access to resources within the assigned scope. Inherits to all child scopes.",
    permissions: READER_PERMISSIONS,
    isBuiltIn: true,
    category: "scoped",
    color: "gray",
  },
  "platform-owner": {
    id: "platform-owner",
    name: "Platform Owner",
    description: "Full access to all resources. Can manage RBAC assignments.",
    permissions: ["*"],
    isBuiltIn: true,
    category: "platform",
    color: "red",
  },
  "platform-admin": {
    id: "platform-admin",
    name: "Platform Admin",
    description: "Manage all apps, configs, users, infrastructure, and cluster operations.",
    permissions: [
      "apps:read", "apps:write", "apps:sync", "apps:delete",
      "config:read", "config:write",
      "catalog:write", "catalog:delete",
      "users:read", "users:write", "users:invite",
      "cluster:read", "cluster:drain", "cluster:scale", "cluster:admin",
      "security:read", "security:write",
      "nas:read", "nas:write",
      "infra:read", "rbac:admin",
      "platform:update",
      "game-hub:read", "game-hub:write", "game-hub:admin", "game-hub:players",
      "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop", "game-hub:scale",
      "wordpress:read", "wordpress:write", "wordpress:admin",
      "jellyfin:read", "jellyfin:admin",
    ],
    isBuiltIn: true,
    category: "platform",
    color: "blue",
  },
  "platform-operator": {
    id: "platform-operator",
    name: "Platform Operator",
    description: "Sync apps, read configs, and manage catalog entries.",
    permissions: ["apps:read", "apps:sync", "config:read", "catalog:write", "users:read", "cluster:read", "game-hub:read", "game-hub:players"],
    isBuiltIn: true,
    category: "platform",
    color: "teal",
  },
  "platform-viewer": {
    id: "platform-viewer",
    name: "Platform Viewer",
    description: "Read-only access to apps, configs, platform health, and game servers.",
    permissions: ["apps:read", "config:read", "users:read", "cluster:read", "security:read", "infra:read", "game-hub:read", "game-hub:players"],
    isBuiltIn: true,
    category: "platform",
    color: "gray",
  },
  viewer: {
    id: "viewer",
    name: "Viewer",
    description: "Read-only access to apps, pods, logs, infrastructure status, and game servers.",
    permissions: ["apps:read", "config:read", "cluster:read", "security:read", "infra:read", "game-hub:read", "game-hub:players"],
    isBuiltIn: true,
    category: "platform",
    color: "gray",
  },
  ops: {
    id: "ops",
    name: "Operations",
    description: "Start and stop services, view pods and logs, without infrastructure or RBAC admin rights.",
    permissions: ["apps:read", "cluster:read", "game-hub:read", "game-hub:players", "game-hub:start", "game-hub:stop"],
    isBuiltIn: true,
    category: "platform",
    color: "orange",
  },
  developer: {
    id: "developer",
    name: "Developer",
    description: "Deploy apps, view logs, and manage community apps without infrastructure or RBAC access.",
    permissions: ["apps:read", "apps:write", "apps:sync", "catalog:write", "cluster:read"],
    isBuiltIn: true,
    category: "platform",
    color: "blue",
  },
  "readonly-infra": {
    id: "readonly-infra",
    name: "Readonly Infrastructure",
    description: "Read-only access to infrastructure status, metrics, pods, and ArgoCD application state.",
    permissions: ["apps:read", "config:read", "cluster:read", "security:read", "infra:read"],
    isBuiltIn: true,
    category: "platform",
    color: "teal",
  },
  "game-server-admin": {
    id: "game-server-admin",
    name: "Game Server Admin",
    description: "Full control over scoped game server(s).",
    permissions: ["game-hub:read", "game-hub:write", "game-hub:admin", "game-hub:players", "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop", "game-hub:scale"],
    isBuiltIn: true,
    category: "game-hub",
    color: "purple",
  },
  "game-server-operator": {
    id: "game-server-operator",
    name: "Game Server Operator",
    description: "Start/stop, console, and file access for scoped server(s).",
    permissions: ["game-hub:read", "game-hub:players", "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop"],
    isBuiltIn: true,
    category: "game-hub",
    color: "orange",
  },
  "game-server-viewer": {
    id: "game-server-viewer",
    name: "Game Server Viewer",
    description: "Read-only access to scoped game server(s).",
    permissions: ["game-hub:read", "game-hub:players"],
    isBuiltIn: true,
    category: "game-hub",
    color: "green",
  },
  "game-hub-player": {
    id: "game-hub-player",
    name: "Game Hub Player",
    description: "View assigned game servers and connection information only.",
    permissions: ["game-hub:read"],
    isBuiltIn: true,
    category: "game-hub",
    color: "green",
  },
  "wiki-viewer": {
    id: "wiki-viewer",
    name: "Wiki Viewer",
    description: "Read wiki content within the assigned scope.",
    permissions: ["wiki:read"],
    isBuiltIn: true,
    category: "wiki",
    color: "gray",
  },
  "wiki-editor": {
    id: "wiki-editor",
    name: "Wiki Editor",
    description: "Read and edit wiki content within the assigned scope.",
    permissions: ["wiki:read", "wiki:edit"],
    isBuiltIn: true,
    category: "wiki",
    color: "blue",
  },
  "wordpress-admin": {
    id: "wordpress-admin",
    name: "WordPress Admin",
    description: "Full control over scoped WordPress site(s), including deletion and SSO.",
    permissions: ["wordpress:read", "wordpress:write", "wordpress:admin"],
    isBuiltIn: true,
    category: "wordpress",
    color: "purple",
  },
  "wordpress-editor": {
    id: "wordpress-editor",
    name: "WordPress Editor",
    description: "Create scoped WordPress site(s) and manage their plugins and SSO.",
    permissions: ["wordpress:read", "wordpress:write"],
    isBuiltIn: true,
    category: "wordpress",
    color: "blue",
  },
  "wordpress-viewer": {
    id: "wordpress-viewer",
    name: "WordPress Viewer",
    description: "Read-only access to scoped WordPress site(s).",
    permissions: ["wordpress:read"],
    isBuiltIn: true,
    category: "wordpress",
    color: "gray",
  },
  // Storage roles are only meaningful when assigned at a `/nas/...` scope (see
  // lib/nas/scope.ts). Assigned at "/" they confer blanket NAS access, which is
  // what platform-admin already carries.
  "storage-viewer": {
    id: "storage-viewer",
    name: "Storage Viewer",
    description: "Browse the scoped share or folder and mount it read-only.",
    permissions: ["nas:read"],
    isBuiltIn: true,
    category: "storage",
    color: "gray",
  },
  "storage-contributor": {
    id: "storage-contributor",
    name: "Storage Contributor",
    description: "Browse, create folders in, and mount the scoped share or folder read-write.",
    permissions: ["nas:read", "nas:write"],
    isBuiltIn: true,
    category: "storage",
    color: "teal",
  },
  // Jellyfin's OIDC only covers the web UI; native and TV clients authenticate
  // against a LOCAL Jellyfin account. Granting one of these roles provisions that
  // account (see lib/jellyfin/access.ts); revoking it disables the account.
  "jellyfin-user": {
    id: "jellyfin-user",
    name: "Jellyfin User",
    description: "A standard Jellyfin account, provisioned automatically on grant.",
    permissions: ["jellyfin:read"],
    isBuiltIn: true,
    category: "jellyfin",
    color: "gray",
  },
  "jellyfin-admin": {
    id: "jellyfin-admin",
    name: "Jellyfin Admin",
    description: "Full control of the Jellyfin server account (administrator).",
    permissions: ["jellyfin:read", "jellyfin:admin"],
    isBuiltIn: true,
    category: "jellyfin",
    color: "purple",
  },
  support: {
    id: "support",
    name: "Support",
    description: "View game server status and player lists without console, files, or admin access.",
    permissions: ["game-hub:read", "game-hub:players"],
    isBuiltIn: true,
    category: "game-hub",
    color: "yellow",
  },
};

const ROLE_ALIASES: Record<string, BuiltInRoleId> = {
  "game-hub-admin": "game-server-admin",
  "game-hub-operator": "game-server-operator",
  "game-hub-viewer": "game-server-viewer",
  "game-hub-server-admin": "game-server-admin",
  "game-hub-server-editor": "game-server-operator",
  "game-hub-server-reader": "game-server-viewer",
};

export type LegacyRole = "admin" | "operator" | "viewer" | "unknown";

export function getRole(groups: string[]): LegacyRole {
  if (groups.includes("platform-admins")) return "admin";
  if (groups.includes("platform-operators")) return "operator";
  if (groups.includes("platform-users")) return "viewer";
  return "unknown";
}

export function getLegacyRoleId(groups: string[]): BuiltInRoleId | null {
  const legacyRole = getRole(groups);
  if (legacyRole === "admin") return "platform-admin";
  if (legacyRole === "operator") return "platform-operator";
  if (legacyRole === "viewer") return "platform-viewer";
  return null;
}

function normalizeRoleId(roleId: RoleId): BuiltInRoleId | null {
  if (roleId in BUILT_IN_ROLES) return roleId as BuiltInRoleId;
  if (roleId in ROLE_ALIASES) return ROLE_ALIASES[roleId];
  return null;
}

export function resolveRoleDefinition(roleId: RoleId): RoleDefinition | null {
  const normalized = normalizeRoleId(roleId);
  return normalized ? BUILT_IN_ROLES[normalized] : null;
}

/** True if the role's notActions explicitly withhold `permission`. */
function roleNotActionsCovers(role: RoleDefinition, permission: Permission): boolean {
  return Boolean(role.notActions && role.notActions.some((granted) => permissionMatches(granted, permission)));
}

export function roleHasPermission(role: RoleDefinition | null, permission: Permission): boolean {
  if (!role) return false;
  if (roleNotActionsCovers(role, permission)) return false;
  return role.permissions.some((granted) => permissionMatches(granted, permission));
}

/**
 * Privilege-ceiling check for role assignment. Returns true if granting `roleId`
 * would confer a permission the granter does not themselves hold — i.e. the
 * assignment would escalate the grantee beyond the granter's own privilege level
 * (e.g. a platform-admin granting platform-owner's "*").
 *
 * A granter holding "*" covers everything. Otherwise every permission in the
 * target role must be present in `granterPerms`; a target role that contains "*"
 * therefore requires the granter to also hold "*". Unknown roles are rejected
 * earlier in the route, so a missing definition is treated as nothing to grant.
 */
export function assignmentExceedsGranter(granterPerms: Set<Permission>, roleId: RoleId): boolean {
  if (granterPerms.has("*")) return false;
  const role = resolveRoleDefinition(roleId);
  if (!role) return false;
  return role.permissions.some((permission) => {
    if (permission === "*") return true; // needs "*", which the granter lacks (checked above)
    return expandPermissionPattern(permission).some((concrete) => !granterPerms.has(concrete));
  });
}

/**
 * Returns true if a grant on `grantScope` covers `requestedScope`, i.e. the
 * requested scope is the granted scope itself or a descendant within its
 * subtree. Matching is boundary-aware on the "/" separator so that a grant on
 * "/game-hub/servers/foo" does NOT leak access to "/game-hub/servers/foobar".
 */
export function scopeCovers(grantScope: string, requestedScope: string): boolean {
  if (grantScope === requestedScope) return true;
  const base = grantScope.endsWith("/") ? grantScope : `${grantScope}/`;
  return requestedScope.startsWith(base);
}

/**
 * Returns true if two scopes overlap in the hierarchy, i.e. one covers the
 * other. Used for "does the user have permission anywhere within this subtree"
 * style checks (e.g. navigation visibility).
 */
export function scopesOverlap(a: string, b: string): boolean {
  return scopeCovers(a, b) || scopeCovers(b, a);
}

/**
 * A scope path in the InfraWeaver hierarchy, Azure-style:
 *   platform (root "/") → resource group ("/wordpress", "/game-hub/servers")
 *   → resource ("/wordpress/sites/foo", "/game-hub/servers/tmodloader").
 * A role assigned on any scope inherits to every descendant scope.
 */
export type ScopePath = string;

export const ROOT_SCOPE: ScopePath = "/";

/** Strips a trailing "/" (except on the root) so scope comparisons are stable. */
function normalizeScope(scope: ScopePath): ScopePath {
  if (!scope || scope === ROOT_SCOPE) return ROOT_SCOPE;
  return scope.endsWith("/") ? scope.slice(0, -1) : scope;
}

/** Path segments of a scope, e.g. "/wordpress/sites/foo" -> [wordpress, sites, foo]. */
export function scopeSegments(scope: ScopePath): string[] {
  return normalizeScope(scope).split("/").filter(Boolean);
}

/** The immediate parent scope, or null for the root. */
export function scopeParent(scope: ScopePath): ScopePath | null {
  const normalized = normalizeScope(scope);
  if (normalized === ROOT_SCOPE) return null;
  const segments = scopeSegments(normalized);
  if (segments.length <= 1) return ROOT_SCOPE;
  return `/${segments.slice(0, -1).join("/")}`;
}

/**
 * The scope itself and every ancestor up to the root, most-specific first.
 * Walking this chain IS the Azure inheritance lookup: a role assigned on any
 * entry applies to `scope`.
 */
export function scopeAncestors(scope: ScopePath): ScopePath[] {
  const chain: ScopePath[] = [];
  let current: ScopePath | null = normalizeScope(scope);
  while (current) {
    chain.push(current);
    current = scopeParent(current);
  }
  if (chain[chain.length - 1] !== ROOT_SCOPE) chain.push(ROOT_SCOPE);
  return chain;
}

/** True when `ancestor` is a STRICT ancestor of `scope` (covers it but isn't it). */
export function isStrictAncestorScope(ancestor: ScopePath, scope: ScopePath): boolean {
  return scopeCovers(ancestor, scope) && normalizeScope(ancestor) !== normalizeScope(scope);
}

/**
 * Does any non-expired assignment covering `scope` confer `permission`, after
 * Azure-style Deny assignments are subtracted?
 *
 * Deny must be honoured here, not only in `getEffectivePermissions`. This helper
 * is the authoritative grant check behind the NAS folder ACL and the client-side
 * `useRBAC().can(permission, scope)`. Resolving it with a bare `.some()` had two
 * failure modes: a Deny carve-out on a subfolder silently did nothing (the
 * parent's Allow still matched), and a Deny assignment on its own returned true —
 * a Deny that granted — because the test only asked whether the assignment's role
 * carries the permission.
 *
 * Deny wins over Allow at any scope, matching `getEffectivePermissions`.
 */
export function hasAssignedPermissionForScope(
  roleAssignments: RoleAssignment[],
  permission: Permission,
  scope: string,
) {
  let allowed = false;
  for (const assignment of roleAssignments) {
    if (isAssignmentExpired(assignment)) continue;
    if (!scopeCovers(assignment.scope, scope)) continue;
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) continue;
    // `roleHasPermission` already subtracts the role's own notActions.
    if (!roleHasPermission(role, permission)) continue;
    if (assignment.effect === "Deny") return false;
    allowed = true;
  }
  return allowed;
}

/**
 * Does the subject hold `permission` ANYWHERE in the subtree around
 * `scopePrefix`? Used for coarse admission and navigation visibility, never as
 * the authorization for a specific resource — pair it with
 * {@link hasAssignedPermissionForScope} on the exact scope.
 *
 * A `Deny` assignment only ever takes access away, so it must not satisfy an
 * admission check on its own.
 */
export function hasAssignedPermissionInScopeTree(
  roleAssignments: RoleAssignment[],
  permission: Permission,
  scopePrefix: string,
) {
  return roleAssignments.some((assignment) => {
    if (assignment.effect === "Deny") return false;
    if (isAssignmentExpired(assignment)) return false;
    if (!scopesOverlap(assignment.scope, scopePrefix)) return false;
    return roleHasPermission(resolveRoleDefinition(assignment.roleId), permission);
  });
}

/** Adds a granted permission (concrete or wildcard) to an allow set, expanding patterns. */
function addAllowedPermission(allow: Set<Permission>, permission: PermissionPattern): void {
  if (permission === "*") {
    allow.add("*");
    return;
  }
  for (const concrete of expandPermissionPattern(permission)) allow.add(concrete);
}

export function getEffectivePermissions(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  scope = "/"
): Set<Permission> {
  const allow = new Set<Permission>();
  const deny = new Set<Permission>();
  let hasNegation = false;

  if (groups.length > 0 || Boolean(username) || roleAssignments.length > 0) {
    allow.add("wiki:read");
  }

  const legacyRole = getRole(groups);
  const legacyRoleId = getLegacyRoleId(groups);

  if (legacyRoleId) {
    for (const permission of BUILT_IN_ROLES[legacyRoleId].permissions) {
      addAllowedPermission(allow, permission);
    }
    if (legacyRole === "admin") {
      allow.add("*");
    }
  }

  for (const assignment of roleAssignments) {
    if (!assignmentAppliesToSubject(assignment, groups, username, scope)) continue;

    const roleDef = resolveRoleDefinition(assignment.roleId);
    if (!roleDef) continue;

    if (assignment.effect === "Deny") {
      hasNegation = true;
      for (const permission of roleDef.permissions) for (const concrete of expandToConcrete(permission)) deny.add(concrete);
    } else {
      for (const permission of roleDef.permissions) addAllowedPermission(allow, permission);
    }
    if (roleDef.notActions && roleDef.notActions.length > 0) {
      hasNegation = true;
      for (const permission of roleDef.notActions) for (const concrete of expandToConcrete(permission)) deny.add(concrete);
    }
  }

  // Back-compat fast path: with no Deny/notActions in play, the allow set IS the
  // effective set (identical to the pre-deny behavior).
  if (!hasNegation || deny.size === 0) return allow;

  // final = allow − deny. Materialize a "*" allow into every concrete permission
  // so a specific Deny can carve out of it; the "*" token is dropped so the
  // subtraction is observable to `hasPermission`.
  const final = allow.has("*") ? new Set<Permission>(ALL_PERMISSIONS.filter((p) => p !== "*")) : new Set<Permission>();
  for (const permission of allow) if (permission !== "*") final.add(permission);
  for (const permission of deny) final.delete(permission);
  return final;
}

export function hasPermission(
  groups: string[],
  permission: Permission,
  roleAssignments: RoleAssignment[] = [],
  scope = "/",
  username = ""
): boolean {
  const perms = getEffectivePermissions(groups, username, roleAssignments, scope);
  return perms.has("*") || perms.has(permission);
}

/** A principal (user or group member) whose access is being evaluated. */
export interface RbacSubject {
  groups: string[];
  username: string;
  roleAssignments: RoleAssignment[];
}

/**
 * Azure-style scoped permission check. Resolves `action` for `subject` at
 * `scope` by inheriting any role assignment made on `scope` or any ANCESTOR
 * scope (walk via scopeCovers / scopeAncestors). Legacy group roles and the
 * platform-owner "*" are honored by the same underlying resolver, so this is a
 * drop-in, identity-aware entry point that keeps every existing permission
 * string and caller working unchanged.
 */
export function isAllowed(
  subject: RbacSubject,
  action: Permission,
  scope: ScopePath = ROOT_SCOPE,
): boolean {
  return hasPermission(subject.groups, action, subject.roleAssignments, scope, subject.username);
}

/** A resolved grant: which role applies at a scope, and whether it was inherited. */
export interface ScopeGrant {
  assignment: RoleAssignment;
  role: RoleDefinition;
  /** True when the grant comes from an ancestor scope rather than `scope` itself. */
  inherited: boolean;
}

/**
 * Every non-expired role assignment that applies to `subject` at `scope`, each
 * tagged `inherited` (assigned on an ancestor scope) or direct (assigned on
 * `scope` itself). Powers the RBAC Visualizer's inheritance view and mirrors the
 * resolution {@link isAllowed} performs.
 */
export function grantsForScope(subject: RbacSubject, scope: ScopePath): ScopeGrant[] {
  const grants: ScopeGrant[] = [];
  for (const assignment of subject.roleAssignments) {
    if (!assignmentAppliesToSubject(assignment, subject.groups, subject.username, scope)) continue;
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) continue;
    grants.push({ assignment, role, inherited: isStrictAncestorScope(assignment.scope, scope) });
  }
  return grants;
}

/** True when an assignment applies to this subject at `scope` (scope + principal + not expired). */
function assignmentAppliesToSubject(
  assignment: RoleAssignment,
  groups: string[],
  username: string,
  scope: ScopePath,
): boolean {
  if (isAssignmentExpired(assignment)) return false;
  if (!scopeCovers(assignment.scope, scope)) return false;
  if (assignment.principalType === "group" && assignment.principalId && !groups.includes(assignment.principalId)) return false;
  if (assignment.principalType === "user" && assignment.principalId && username && assignment.principalId !== username) return false;
  return true;
}

export type PermissionEffect = "Allow" | "Deny" | "NotApplicable";

export interface PermissionExplanation {
  allowed: boolean;
  effect: PermissionEffect;
  /** The assignment(s) that decided the outcome (the denies, or the allows). */
  decidingAssignments: RoleAssignment[];
}

/**
 * Explains WHY `action` is (dis)allowed for a subject at `scope`: the boolean
 * decision plus the assignment(s) that decided it. Deny wins over Allow, matching
 * {@link getEffectivePermissions}. When only legacy group roles / defaults decide
 * (no per-assignment reason), `decidingAssignments` is empty. Powers the RBAC
 * "explain access" surface.
 */
export function explainPermission(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  action: Permission,
  scope: ScopePath = ROOT_SCOPE,
): PermissionExplanation {
  const applicable = roleAssignments.filter((a) => assignmentAppliesToSubject(a, groups, username, scope));

  const denies = applicable.filter((assignment) => {
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) return false;
    if (assignment.effect === "Deny") return role.permissions.some((granted) => permissionMatches(granted, action));
    return roleNotActionsCovers(role, action);
  });
  if (denies.length > 0) return { allowed: false, effect: "Deny", decidingAssignments: denies };

  const allows = applicable.filter((assignment) => {
    if (assignment.effect === "Deny") return false;
    return roleHasPermission(resolveRoleDefinition(assignment.roleId), action);
  });
  if (allows.length > 0) return { allowed: true, effect: "Allow", decidingAssignments: allows };

  // No per-assignment reason: defer to the full resolver (legacy group roles, defaults).
  const allowed = hasPermission(groups, action, roleAssignments, scope, username);
  return { allowed, effect: allowed ? "Allow" : "NotApplicable", decidingAssignments: [] };
}

export function getBuiltInRoles(): RoleDefinition[] {
  return Object.values(BUILT_IN_ROLES);
}

export function isAssignmentExpired(assignment: { expiresAt?: string }, now: number = Date.now()): boolean {
  if (!assignment.expiresAt) return false;
  const expiry = new Date(assignment.expiresAt).getTime();
  // Fail closed: an unparseable expiry must be treated as EXPIRED, never as a
  // permanent grant (NaN < now is false, which would silently make the grant
  // never expire).
  if (Number.isNaN(expiry)) return true;
  return expiry < now;
}

export const STATIC_SCOPES = [
  { value: "/", label: "Cluster-wide" },
  { value: "/game-hub/", label: "All Game Hub servers" },
  { value: "/wiki", label: "Wiki" },
  { value: "/nas", label: "All storage" },
  { value: "/jellyfin", label: "Jellyfin" },
];

export function gameServerScope(serverName: string): string {
  return `/game-hub/servers/${serverName}`;
}

export function scopeLabel(scope: string): string {
  const known = STATIC_SCOPES.find((entry) => entry.value === scope);
  if (known) return known.label;
  if (scope === "/game-hub" || scope === "/game-hub/servers") return "All Game Hub servers";
  const serverMatch = scope.match(/^\/game-hub\/servers\/(.+)$/);
  if (serverMatch) return `Server: ${serverMatch[1]}`;
  const wordpressSiteMatch = scope.match(/^\/wordpress\/sites\/(.+)$/);
  if (wordpressSiteMatch) return `WordPress: ${wordpressSiteMatch[1]}`;
  if (scope === "/wordpress" || scope === "/wordpress/sites") return "All WordPress sites";
  // Storage scopes are `/nas/<provider>[/<share>[/<folder…>]]` — see lib/nas/scope.ts.
  const nasMatch = scope.match(/^\/nas\/(.+)$/);
  if (nasMatch) return `Storage: ${nasMatch[1].split("/").join(" / ")}`;
  return scope;
}

export function buildScopes(serverNames: string[] = []) {
  return [
    ...STATIC_SCOPES,
    ...serverNames.map((serverName) => ({ value: gameServerScope(serverName), label: `Server: ${serverName}` })),
  ];
}

export const ROLE_COLOR_CLASSES = {
  red: { badge: "bg-red-500/10 border-red-500/30 text-red-300", dot: "bg-red-400" },
  blue: { badge: "bg-blue-500/10 border-blue-500/30 text-blue-300", dot: "bg-blue-400" },
  green: { badge: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300", dot: "bg-emerald-400" },
  purple: { badge: "bg-purple-500/10 border-purple-500/30 text-purple-300", dot: "bg-purple-400" },
  orange: { badge: "bg-orange-500/10 border-orange-500/30 text-orange-300", dot: "bg-orange-400" },
  yellow: { badge: "bg-yellow-500/10 border-yellow-500/30 text-yellow-300", dot: "bg-yellow-400" },
  teal: { badge: "bg-teal-500/10 border-teal-500/30 text-teal-300", dot: "bg-teal-400" },
  gray: { badge: "bg-slate-500/10 border-slate-500/30 text-slate-700 dark:text-slate-300", dot: "bg-slate-400" },
} as const;
