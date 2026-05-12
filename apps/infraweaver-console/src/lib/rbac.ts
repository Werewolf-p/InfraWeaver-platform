// ─── Permission strings ───────────────────────────────────────────────────────
export type Permission =
  // ── Legacy (kept for full backward compatibility) ──────────────────────────
  | "*"
  | "apps:read" | "apps:write" | "apps:sync"
  | "config:read" | "config:write"
  | "catalog:write"
  | "users:read" | "users:write"
  // ── New granular permissions (Azure-style: domain/resource/action) ──────────
  | "platform/apps/read" | "platform/apps/write" | "platform/apps/sync" | "platform/apps/delete"
  | "platform/config/read" | "platform/config/write"
  | "platform/users/read" | "platform/users/write"
  | "platform/audit/read"
  | "game-hub/servers/read" | "game-hub/servers/write" | "game-hub/servers/delete"
  | "game-hub/servers/console"
  | "game-hub/servers/files/read" | "game-hub/servers/files/write"
  | "storage/pvcs/read" | "storage/pvcs/delete"
  | "network/read" | "network/write"
  | "catalog/apps/read" | "catalog/apps/deploy" | "catalog/apps/delete";

// ─── Role assignment (stored per-user in users.yaml) ─────────────────────────
export interface RoleAssignment {
  id: string;
  roleId: string;
  /** Hierarchical scope: "/" = global, "/game-hub/" = all game-hub, "/game-hub/servers/mc" = one server */
  scope: string;
  grantedBy: string;
  grantedAt: string;
}

// ─── Role definition ──────────────────────────────────────────────────────────
export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  category: "platform" | "game-hub" | "storage" | "network" | "catalog";
  permissions: Permission[];
  /** Tailwind color key for badge */
  color: "red" | "blue" | "green" | "purple" | "orange" | "yellow" | "teal" | "gray";
}

// ─── Built-in roles ───────────────────────────────────────────────────────────
export const BUILT_IN_ROLES: RoleDefinition[] = [
  {
    id: "platform-admin",
    name: "Platform Administrator",
    description: "Full access to all platform resources and settings",
    isBuiltIn: true,
    category: "platform",
    permissions: ["*"],
    color: "red",
  },
  {
    id: "platform-editor",
    name: "Platform Editor",
    description: "Read and write access across the platform — no admin or delete",
    isBuiltIn: true,
    category: "platform",
    permissions: [
      "platform/apps/read", "platform/apps/write", "platform/apps/sync",
      "platform/config/read", "platform/config/write",
      "platform/users/read",
      "game-hub/servers/read", "game-hub/servers/write",
      "game-hub/servers/console", "game-hub/servers/files/read", "game-hub/servers/files/write",
      "storage/pvcs/read",
      "network/read",
      "catalog/apps/read", "catalog/apps/deploy",
    ],
    color: "blue",
  },
  {
    id: "platform-viewer",
    name: "Platform Viewer",
    description: "Read-only access to all platform resources",
    isBuiltIn: true,
    category: "platform",
    permissions: [
      "platform/apps/read", "platform/config/read",
      "platform/users/read", "platform/audit/read",
      "game-hub/servers/read", "game-hub/servers/files/read",
      "storage/pvcs/read",
      "network/read",
      "catalog/apps/read",
    ],
    color: "green",
  },
  {
    id: "game-hub-admin",
    name: "Game Hub Administrator",
    description: "Full control over all game servers including delete and file management",
    isBuiltIn: true,
    category: "game-hub",
    permissions: [
      "game-hub/servers/read", "game-hub/servers/write", "game-hub/servers/delete",
      "game-hub/servers/console", "game-hub/servers/files/read", "game-hub/servers/files/write",
      "storage/pvcs/read", "storage/pvcs/delete",
    ],
    color: "purple",
  },
  {
    id: "game-hub-operator",
    name: "Game Hub Operator",
    description: "Start, stop, restart game servers; full console and file access",
    isBuiltIn: true,
    category: "game-hub",
    permissions: [
      "game-hub/servers/read", "game-hub/servers/write",
      "game-hub/servers/console", "game-hub/servers/files/read", "game-hub/servers/files/write",
    ],
    color: "orange",
  },
  {
    id: "game-hub-viewer",
    name: "Game Hub Viewer",
    description: "Read-only access to game servers and files",
    isBuiltIn: true,
    category: "game-hub",
    permissions: ["game-hub/servers/read", "game-hub/servers/files/read"],
    color: "gray",
  },
  {
    id: "game-hub-server-admin",
    name: "Game Server Admin",
    description: "Full control over a specific game server — scoped via assignment",
    isBuiltIn: true,
    category: "game-hub",
    permissions: [
      "game-hub/servers/read", "game-hub/servers/write", "game-hub/servers/delete",
      "game-hub/servers/console", "game-hub/servers/files/read", "game-hub/servers/files/write",
    ],
    color: "red",
  },
  {
    id: "game-hub-server-editor",
    name: "Game Server Editor",
    description: "Start, stop, use console and manage files on a specific server",
    isBuiltIn: true,
    category: "game-hub",
    permissions: [
      "game-hub/servers/read", "game-hub/servers/write",
      "game-hub/servers/console", "game-hub/servers/files/read", "game-hub/servers/files/write",
    ],
    color: "orange",
  },
  {
    id: "game-hub-server-reader",
    name: "Game Server Reader",
    description: "View status and browse files on a specific server — no console or changes",
    isBuiltIn: true,
    category: "game-hub",
    permissions: ["game-hub/servers/read", "game-hub/servers/files/read"],
    color: "green",
  },
  {
    id: "storage-admin",
    name: "Storage Administrator",
    description: "View and delete persistent volume claims",
    isBuiltIn: true,
    category: "storage",
    permissions: ["storage/pvcs/read", "storage/pvcs/delete"],
    color: "yellow",
  },
  {
    id: "catalog-deployer",
    name: "Catalog Deployer",
    description: "Browse catalog and deploy applications; cannot delete",
    isBuiltIn: true,
    category: "catalog",
    permissions: ["catalog/apps/read", "catalog/apps/deploy"],
    color: "teal",
  },
];

// ─── Lookup ───────────────────────────────────────────────────────────────────
export const ROLE_BY_ID: Record<string, RoleDefinition> = Object.fromEntries(
  BUILT_IN_ROLES.map(r => [r.id, r])
);

// ─── Legacy role system (unchanged — all existing routes still work) ──────────
export type LegacyRole = "admin" | "operator" | "viewer" | "unknown";

const LEGACY_ROLE_PERMISSIONS: Record<LegacyRole, Permission[]> = {
  admin:    ["*"],
  operator: ["apps:read", "apps:sync", "config:read", "catalog:write", "users:read"],
  viewer:   ["apps:read", "config:read", "users:read"],
  unknown:  [],
};

export function getRole(groups: string[]): LegacyRole {
  if (groups.includes("platform-admins"))    return "admin";
  if (groups.includes("platform-operators")) return "operator";
  if (groups.includes("platform-users"))     return "viewer";
  return "unknown";
}

/** Legacy hasPermission — used by all existing API routes (unchanged API) */
export function hasPermission(groups: string[], permission: Permission): boolean {
  const role = getRole(groups);
  const perms = LEGACY_ROLE_PERMISSIONS[role];
  return perms.includes("*") || perms.includes(permission);
}

// ─── New permission check (groups + role assignments + scope) ─────────────────
/**
 * Full permission check: evaluates both legacy Authentik groups AND new
 * role assignments. Scope is hierarchical — assignment at "/" covers everything;
 * assignment at "/game-hub/" covers any sub-path.
 */
export function checkPermission(
  groups: string[],
  roleAssignments: RoleAssignment[],
  permission: Permission,
  scope = "/",
): boolean {
  // Admin from Authentik groups always wins
  if (getRole(groups) === "admin") return true;

  for (const assignment of roleAssignments) {
    const assignScope = assignment.scope ?? "/";
    // Scope must be ancestor of or equal to target scope
    if (assignScope !== "/" && !scope.startsWith(assignScope)) continue;

    const role = ROLE_BY_ID[assignment.roleId];
    if (!role) continue;

    if (role.permissions.includes("*" as Permission)) return true;
    if (role.permissions.includes(permission)) return true;
  }

  return false;
}

// ─── Scope helpers ────────────────────────────────────────────────────────────
/** Static well-known scopes always shown in the UI */
export const STATIC_SCOPES = [
  { value: "/",                 label: "Platform (all resources)" },
  { value: "/game-hub/",        label: "Game Hub (all servers)" },
  { value: "/storage/",         label: "Storage (all PVCs)" },
  { value: "/catalog/",         label: "Catalog (all apps)" },
  { value: "/network/",         label: "Network" },
];

/** Build dynamic scope for a specific game server */
export function gameServerScope(serverName: string): string {
  return `/game-hub/servers/${serverName}`;
}

/** Human-readable label for any scope string */
export function scopeLabel(scope: string): string {
  const known = STATIC_SCOPES.find(s => s.value === scope);
  if (known) return known.label;
  // /game-hub/servers/<name>
  const serverMatch = scope.match(/^\/game-hub\/servers\/(.+)$/);
  if (serverMatch) return `Server: ${serverMatch[1]}`;
  return scope;
}

/** All scopes = static + per-server (dynamic, provided by caller) */
export function buildScopes(serverNames: string[] = []) {
  return [
    ...STATIC_SCOPES,
    ...serverNames.map(n => ({ value: gameServerScope(n), label: `Server: ${n}` })),
  ];
}

// Keep SCOPES as alias for static-only (backward compat)
export const SCOPES = STATIC_SCOPES;

// ─── UI color maps ────────────────────────────────────────────────────────────
export const ROLE_COLOR_CLASSES: Record<RoleDefinition["color"], { badge: string; dot: string }> = {
  red:    { badge: "bg-red-900/30 text-red-300 border-red-700/40",       dot: "bg-red-400" },
  blue:   { badge: "bg-blue-900/30 text-blue-300 border-blue-700/40",    dot: "bg-blue-400" },
  green:  { badge: "bg-green-900/30 text-green-300 border-green-700/40", dot: "bg-green-400" },
  purple: { badge: "bg-purple-900/30 text-purple-300 border-purple-700/40", dot: "bg-purple-400" },
  orange: { badge: "bg-orange-900/30 text-orange-300 border-orange-700/40", dot: "bg-orange-400" },
  yellow: { badge: "bg-yellow-900/30 text-yellow-300 border-yellow-700/40", dot: "bg-yellow-400" },
  teal:   { badge: "bg-teal-900/30 text-teal-300 border-teal-700/40",    dot: "bg-teal-400" },
  gray:   { badge: "bg-[#222] text-[#999] border-[#333]",               dot: "bg-[#666]" },
};
