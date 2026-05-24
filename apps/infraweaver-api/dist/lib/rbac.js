const ROLE_PERMISSIONS = {
    'platform-owner': ['*'],
    'platform-admin': ['apps:read', 'apps:write', 'apps:sync', 'apps:delete', 'config:read', 'config:write', 'catalog:write', 'catalog:delete', 'users:read', 'users:write', 'cluster:read', 'cluster:drain', 'cluster:scale', 'cluster:admin', 'infra:read', 'rbac:admin'],
    'platform-operator': ['apps:read', 'apps:write', 'apps:sync', 'config:read', 'cluster:read', 'infra:read', 'game-hub:read', 'game-hub:write'],
    'platform-viewer': ['apps:read', 'config:read', 'cluster:read', 'infra:read'],
    viewer: ['apps:read', 'config:read', 'cluster:read'],
};
export function hasPermission(user, permission) {
    for (const role of user.roles) {
        const perms = ROLE_PERMISSIONS[role] ?? [];
        if (perms.includes('*') || perms.includes(permission)) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=rbac.js.map