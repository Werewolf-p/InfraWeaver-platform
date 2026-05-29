import type { UserContext } from '../types/index.js';
import { getCoreApiForCluster } from './k8s-client.js';

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
  const elevated = elevatedPermissions.get(user);
  if (elevated && (elevated.has('*') || elevated.has(permission))) {
    return true;
  }
  return false;
}

// ── PIM / custom-group elevation enforcement ──────────────────────────────────
//
// Authorization MUST honor (a) currently-active, non-expired PIM elevations and
// (b) custom-group memberships, both persisted by the console in a ConfigMap in
// the console namespace. The console signs the request with the user's Authentik
// groups; the backend then *independently* re-reads the ConfigMap and merges any
// extra permissions into the decision so a compromised/forged client cannot grant
// itself elevated access. This is fail-secure: any parse/read failure or expired
// elevation contributes zero permissions.

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'infraweaver-console';
const ACCESS_CONFIGMAP = process.env.ACCESS_CONFIGMAP_NAME ?? 'infraweaver-access-control';

/** PIM role → permissions. Kept in sync with the console's PIM_ROLES catalog. */
const PIM_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  'security-reader': ['security:read'],
  'security-admin': ['security:read', 'security:write'],
  'cluster-admin': ['cluster:read', 'cluster:drain', 'cluster:scale', 'cluster:admin'],
  'rbac-admin': ['rbac:admin'],
  'platform-updater': ['platform:update'],
};

interface RawActivation {
  user?: string;
  role?: string;
  expiresAt?: string;
  deactivatedAt?: string;
}

interface RawGroup {
  id?: string;
  name?: string;
  permissions?: string[];
  members?: string[];
}

const elevatedPermissions = new WeakMap<UserContext, Set<string>>();

export function setElevatedPermissions(user: UserContext, permissions: Iterable<string>): void {
  elevatedPermissions.set(user, new Set(permissions));
}

function normalizeId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function safeParseArray<T>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function isActivationActive(activation: RawActivation, now: number): boolean {
  if (activation.deactivatedAt) return false;
  if (!activation.expiresAt) return false;
  const expires = Date.parse(activation.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires > now;
}

/**
 * Reads the access-control ConfigMap and computes the extra permissions the
 * given identity currently holds via active PIM elevations and custom-group
 * membership. Returns an empty set on any failure (fail-secure).
 */
export async function computeElevatedPermissions(
  userId: string,
  groups: string[],
): Promise<Set<string>> {
  const perms = new Set<string>();
  const identity = normalizeId(userId);
  if (!identity) return perms;
  const groupIds = new Set(groups.map((g) => normalizeId(g)));

  try {
    const coreApi = await getCoreApiForCluster('local');
    const configMap = await coreApi.readNamespacedConfigMap({ name: ACCESS_CONFIGMAP, namespace: CONSOLE_NAMESPACE });
    const data = (configMap as { data?: Record<string, string | undefined> }).data ?? {};
    const now = Date.now();

    // (a) Active, non-expired PIM elevations for this user.
    for (const activation of safeParseArray<RawActivation>(data.activations)) {
      if (!isActivationActive(activation, now)) continue;
      if (normalizeId(activation.user) !== identity) continue;
      for (const perm of PIM_ROLE_PERMISSIONS[activation.role ?? ''] ?? []) perms.add(perm);
    }

    // (b) Custom-group membership (member email/username, or matching Authentik group).
    for (const group of safeParseArray<RawGroup>(data.groups)) {
      const members = (group.members ?? []).map((m) => normalizeId(m));
      const isMember =
        members.includes(identity) ||
        groupIds.has(normalizeId(group.id)) ||
        groupIds.has(normalizeId(group.name));
      if (!isMember) continue;
      for (const perm of group.permissions ?? []) perms.add(perm);
    }
  } catch {
    return new Set<string>();
  }

  return perms;
}

/**
 * Convenience used by the auth middleware: load and attach the user's elevated
 * permissions to the request-scoped user context.
 */
export async function applyElevatedPermissions(user: UserContext): Promise<void> {
  const perms = await computeElevatedPermissions(user.id, user.roles);
  setElevatedPermissions(user, perms);
}

