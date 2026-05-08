export type Permission =
  | "*"
  | "apps:read"
  | "apps:sync"
  | "config:read"
  | "config:write"
  | "catalog:write"
  | "users:read"
  | "users:write";

export type Role = "admin" | "operator" | "viewer" | "unknown";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ["*"],
  operator: ["apps:read", "apps:sync", "config:read", "catalog:write", "users:read"],
  viewer: ["apps:read", "config:read", "users:read"],
  unknown: [],
};

export function getRole(groups: string[]): Role {
  if (groups.includes("platform-admins")) return "admin";
  if (groups.includes("platform-operators")) return "operator";
  if (groups.includes("platform-users")) return "viewer";
  return "unknown";
}

export function hasPermission(groups: string[], permission: Permission): boolean {
  const role = getRole(groups);
  const perms = ROLE_PERMISSIONS[role];
  return perms.includes("*") || perms.includes(permission);
}
