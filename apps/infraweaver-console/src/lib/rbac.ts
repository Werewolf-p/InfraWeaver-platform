export type Permission =
  | "*"
  | "apps:read" | "apps:write" | "apps:sync" | "apps:delete"
  | "config:read" | "config:write"
  | "catalog:write" | "catalog:delete"
  | "users:read" | "users:write" | "users:invite"
  | "cluster:read" | "cluster:drain" | "cluster:scale" | "cluster:admin"
  | "security:read" | "security:write"
  | "nas:read" | "nas:write"
  | "game-hub:read" | "game-hub:write" | "game-hub:admin"
  | "game-hub:console" | "game-hub:files" | "game-hub:start" | "game-hub:stop" | "game-hub:scale";

export type BuiltInRoleId =
  | "platform-owner"
  | "platform-admin"
  | "platform-operator"
  | "platform-viewer"
  | "game-server-admin"
  | "game-server-operator"
  | "game-server-viewer";

export type RoleId = BuiltInRoleId | string;

export interface RoleDefinition {
  id: RoleId;
  name: string;
  description: string;
  permissions: Permission[];
  isBuiltIn: boolean;
  category?: "platform" | "game-hub";
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
}

export const BUILT_IN_ROLES: Record<BuiltInRoleId, RoleDefinition> = {
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
    description: "Manage all apps, configs, users, and cluster operations.",
    permissions: [
      "apps:read", "apps:sync", "apps:delete",
      "config:read", "config:write",
      "catalog:write", "catalog:delete",
      "users:read", "users:write", "users:invite",
      "cluster:read", "cluster:drain", "cluster:scale", "cluster:admin",
      "security:read", "security:write",
      "nas:read", "nas:write",
      "game-hub:read", "game-hub:write", "game-hub:admin",
      "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop", "game-hub:scale",
    ],
    isBuiltIn: true,
    category: "platform",
    color: "blue",
  },
  "platform-operator": {
    id: "platform-operator",
    name: "Platform Operator",
    description: "Sync apps, read configs, and manage catalog entries.",
    permissions: ["apps:read", "apps:sync", "config:read", "catalog:write", "users:read", "cluster:read", "game-hub:read"],
    isBuiltIn: true,
    category: "platform",
    color: "teal",
  },
  "platform-viewer": {
    id: "platform-viewer",
    name: "Platform Viewer",
    description: "Read-only access to apps, configs, and platform health.",
    permissions: ["apps:read", "config:read", "users:read", "cluster:read", "security:read", "game-hub:read"],
    isBuiltIn: true,
    category: "platform",
    color: "gray",
  },
  "game-server-admin": {
    id: "game-server-admin",
    name: "Game Server Admin",
    description: "Full control over scoped game server(s).",
    permissions: ["game-hub:read", "game-hub:write", "game-hub:admin", "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop", "game-hub:scale"],
    isBuiltIn: true,
    category: "game-hub",
    color: "purple",
  },
  "game-server-operator": {
    id: "game-server-operator",
    name: "Game Server Operator",
    description: "Start/stop, console, and file access for scoped server(s).",
    permissions: ["game-hub:read", "game-hub:console", "game-hub:files", "game-hub:start", "game-hub:stop"],
    isBuiltIn: true,
    category: "game-hub",
    color: "orange",
  },
  "game-server-viewer": {
    id: "game-server-viewer",
    name: "Game Server Viewer",
    description: "Read-only access to scoped game server(s).",
    permissions: ["game-hub:read"],
    isBuiltIn: true,
    category: "game-hub",
    color: "green",
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

function normalizeRoleId(roleId: RoleId): BuiltInRoleId | null {
  if (roleId in BUILT_IN_ROLES) return roleId as BuiltInRoleId;
  if (roleId in ROLE_ALIASES) return ROLE_ALIASES[roleId];
  return null;
}

export function resolveRoleDefinition(roleId: RoleId): RoleDefinition | null {
  const normalized = normalizeRoleId(roleId);
  return normalized ? BUILT_IN_ROLES[normalized] : null;
}

export function getEffectivePermissions(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  scope = "/"
): Set<Permission> {
  const perms = new Set<Permission>();

  const legacyRole = getRole(groups);
  let legacyRoleId: BuiltInRoleId | null = null;
  if (legacyRole === "admin") legacyRoleId = "platform-admin";
  else if (legacyRole === "operator") legacyRoleId = "platform-operator";
  else if (legacyRole === "viewer") legacyRoleId = "platform-viewer";

  if (legacyRoleId) {
    for (const permission of BUILT_IN_ROLES[legacyRoleId].permissions) {
      perms.add(permission);
    }
    if (legacyRole === "admin") {
      perms.add("*");
    }
  }

  const now = new Date();
  for (const assignment of roleAssignments) {
    if (assignment.expiresAt && new Date(assignment.expiresAt) < now) continue;
    if (!scope.startsWith(assignment.scope)) continue;
    if (assignment.principalType === "group" && assignment.principalId && !groups.includes(assignment.principalId)) continue;
    if (assignment.principalType === "user" && assignment.principalId && username && assignment.principalId !== username) continue;

    const roleDef = resolveRoleDefinition(assignment.roleId);
    if (!roleDef) continue;

    for (const permission of roleDef.permissions) {
      perms.add(permission);
    }
  }

  return perms;
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

export function hasPermissionLegacy(groups: string[], permission: Permission): boolean {
  return hasPermission(groups, permission, [], "/");
}

export function checkPermission(
  groups: string[],
  roleAssignments: RoleAssignment[],
  permission: Permission,
  scope = "/",
  username = ""
): boolean {
  return hasPermission(groups, permission, roleAssignments, scope, username);
}

export function getBuiltInRoles(): RoleDefinition[] {
  return Object.values(BUILT_IN_ROLES);
}

export function isAssignmentExpired(assignment: RoleAssignment): boolean {
  if (!assignment.expiresAt) return false;
  return new Date(assignment.expiresAt) < new Date();
}

export const STATIC_SCOPES = [
  { value: "/", label: "Cluster-wide" },
  { value: "/game-hub/", label: "All Game Hub servers" },
];

export function gameServerScope(serverName: string): string {
  return `/game-hub/servers/${serverName}`;
}

export function scopeLabel(scope: string): string {
  const known = STATIC_SCOPES.find((entry) => entry.value === scope);
  if (known) return known.label;
  const serverMatch = scope.match(/^\/game-hub\/servers\/(.+)$/);
  if (serverMatch) return `Server: ${serverMatch[1]}`;
  return scope;
}

export function buildScopes(serverNames: string[] = []) {
  return [
    ...STATIC_SCOPES,
    ...serverNames.map((serverName) => ({ value: gameServerScope(serverName), label: `Server: ${serverName}` })),
  ];
}

export const SCOPES = STATIC_SCOPES;

export const ROLE_COLOR_CLASSES = {
  red: { badge: "bg-red-500/10 border-red-500/30 text-red-300", dot: "bg-red-400" },
  blue: { badge: "bg-blue-500/10 border-blue-500/30 text-blue-300", dot: "bg-blue-400" },
  green: { badge: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300", dot: "bg-emerald-400" },
  purple: { badge: "bg-purple-500/10 border-purple-500/30 text-purple-300", dot: "bg-purple-400" },
  orange: { badge: "bg-orange-500/10 border-orange-500/30 text-orange-300", dot: "bg-orange-400" },
  yellow: { badge: "bg-yellow-500/10 border-yellow-500/30 text-yellow-300", dot: "bg-yellow-400" },
  teal: { badge: "bg-teal-500/10 border-teal-500/30 text-teal-300", dot: "bg-teal-400" },
  gray: { badge: "bg-slate-500/10 border-slate-500/30 text-slate-300", dot: "bg-slate-400" },
} as const;
