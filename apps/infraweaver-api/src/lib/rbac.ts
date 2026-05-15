import type { UserContext } from '../types/index.js';

export type Permission =
  | '*'
  | 'apps:read' | 'apps:write' | 'apps:sync' | 'apps:delete'
  | 'config:read' | 'config:write'
  | 'catalog:write' | 'catalog:delete'
  | 'users:read' | 'users:write' | 'users:invite'
  | 'cluster:read' | 'cluster:drain' | 'cluster:scale' | 'cluster:admin'
  | 'security:read' | 'security:write'
  | 'nas:read' | 'nas:write'
  | 'infra:read' | 'rbac:admin'
  | 'game-hub:read' | 'game-hub:write' | 'game-hub:admin'
  | 'game-hub:players'
  | 'game-hub:console' | 'game-hub:files' | 'game-hub:start' | 'game-hub:stop' | 'game-hub:scale'
  | 'wiki:read' | 'wiki:edit';

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  'platform-owner': ['*'],
  'platform-admin': ['apps:read', 'apps:write', 'apps:sync', 'apps:delete', 'config:read', 'config:write', 'catalog:write', 'catalog:delete', 'users:read', 'users:write', 'cluster:read', 'cluster:drain', 'cluster:scale', 'cluster:admin', 'infra:read', 'rbac:admin'],
  'platform-operator': ['apps:read', 'apps:write', 'apps:sync', 'config:read', 'cluster:read', 'infra:read', 'game-hub:read', 'game-hub:write'],
  'platform-viewer': ['apps:read', 'config:read', 'cluster:read', 'infra:read'],
  viewer: ['apps:read', 'config:read', 'cluster:read'],
};

export function hasPermission(user: UserContext, permission: Permission): boolean {
  for (const role of user.roles) {
    const perms = ROLE_PERMISSIONS[role] ?? [];
    if (perms.includes('*') || perms.includes(permission)) {
      return true;
    }
  }
  return false;
}

export function checkPermission(user: UserContext, permission: string): boolean {
  for (const role of user.roles) {
    const perms = ROLE_PERMISSIONS[role] ?? [];
    if (perms.includes('*') || perms.includes(permission as Permission)) {
      return true;
    }
  }
  return false;
}
