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
  | 'platform:update'
  | 'game-hub:read' | 'game-hub:write' | 'game-hub:admin'
  | 'game-hub:players'
  | 'game-hub:console' | 'game-hub:files' | 'game-hub:start' | 'game-hub:stop' | 'game-hub:scale'
  | 'wiki:read' | 'wiki:edit';

const ADMIN_PERMISSIONS: Permission[] = [
  'apps:read', 'apps:write', 'apps:sync', 'apps:delete',
  'config:read', 'config:write',
  'catalog:write', 'catalog:delete',
  'users:read', 'users:write',
  'cluster:read', 'cluster:drain', 'cluster:scale', 'cluster:admin',
  'security:read', 'security:write',
  'infra:read', 'rbac:admin', 'platform:update',
];

const OPERATOR_PERMISSIONS: Permission[] = [
  'apps:read', 'apps:write', 'apps:sync',
  'config:read', 'cluster:read', 'infra:read',
  'game-hub:read', 'game-hub:write',
];

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  'platform-owner': ['*'],
  // Canonical role names
  'platform-admin':    ADMIN_PERMISSIONS,
  'platform-operator': OPERATOR_PERMISSIONS,
  'platform-viewer':   ['apps:read', 'config:read', 'cluster:read', 'infra:read'],
  'viewer':            ['apps:read', 'config:read', 'cluster:read'],
  // Authentik group name aliases (pluralised form as created in Authentik)
  'platform-admins': ADMIN_PERMISSIONS,
  'platform-users':  OPERATOR_PERMISSIONS,
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

