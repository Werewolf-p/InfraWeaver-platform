import type { NavGroup, NavItem } from "@/lib/nav-config";
import {
  hasAssignedPermissionInScopeTree,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";

interface NavRequirement {
  any?: Permission[];
  scopePrefix?: string;
}

const NAV_REQUIREMENTS: Record<string, NavRequirement> = {
  "/apps": { any: ["apps:read"] },
  "/events": { any: ["apps:read"] },
  "/pods": { any: ["cluster:read", "infra:read"] },
  "/cluster": { any: ["infra:read"] },
  "/quota": { any: ["infra:read"] },
  "/node-top": { any: ["infra:read"] },
  "/storage": { any: ["infra:read"] },
  "/network": { any: ["infra:read"] },
  "/ingress": { any: ["infra:read"] },
  "/certificates": { any: ["security:read", "infra:read"] },
  "/network-policies": { any: ["infra:read"] },
  "/secret-expiry": { any: ["security:read", "infra:read"] },
  "/config": { any: ["config:read"] },
  "/logs": { any: ["cluster:read", "infra:read"] },
  "/cronjobs": { any: ["infra:read"] },
  "/maintenance": { any: ["infra:read"] },
  "/gitops-diff": { any: ["infra:read"] },
  "/pipelines": { any: ["infra:read"] },
  "/health": { any: ["infra:read"] },
  "/security": { any: ["security:read", "infra:read"] },
  "/uptime": { any: ["infra:read"] },
  "/image-vulnerabilities": { any: ["security:read", "infra:read"] },
  "/game-hub": { any: ["game-hub:read"], scopePrefix: "/game-hub/" },
  "/game-hub/new": { any: ["game-hub:admin"], scopePrefix: "/game-hub/" },
  "/gameservers": { any: ["infra:read"] },
  "/pod-shell": { any: ["cluster:admin"] },
  "/rbac-viz": { any: ["rbac:admin"] },
  "/resource-optimizer": { any: ["infra:read"] },
  "/app-graph": { any: ["apps:read"] },
  "/log-analytics": { any: ["cluster:read", "infra:read"] },
  "/health-tester": { any: ["infra:read"] },
  "/webhook-tester": { any: ["config:write"] },
  "/alert-silence": { any: ["config:write"] },
  "/config-drift": { any: ["infra:read"] },
  "/deployment-compare": { any: ["infra:read"] },
  "/namespace-cleanup": { any: ["cluster:admin"] },
  "/pv-browser": { any: ["cluster:admin"] },
  "/cost": { any: ["infra:read"] },
  "/storage-timeline": { any: ["infra:read"] },
  "/scheduled-tasks": { any: ["config:write"] },
  "/tests": { any: ["infra:read"] },
  "/self-test": { any: ["infra:read"] },
  "/users": { any: ["users:read", "rbac:admin"] },
  "/registry": { any: ["config:read"] },
  "/settings/addons": { any: ["config:read"] },
  "/settings/rbac": { any: ["rbac:admin"] },
  "/settings/infrastructure": { any: ["infra:read"] },
};

function hasPermissionMatch(permissionSet: Set<string>, permission: Permission) {
  return permissionSet.has("*") || permissionSet.has(permission);
}

export function canAccessNavHref(
  href: string,
  permissions: Iterable<string>,
  roleAssignments: RoleAssignment[] = [],
) {
  const permissionSet = new Set(permissions);
  const requirement = NAV_REQUIREMENTS[href];

  if (!requirement?.any?.length) return true;
  if (requirement.any.some((permission) => hasPermissionMatch(permissionSet, permission))) {
    return true;
  }

  if (requirement.scopePrefix) {
    return requirement.any.some((permission) =>
      hasAssignedPermissionInScopeTree(roleAssignments, permission, requirement.scopePrefix!),
    );
  }

  return false;
}

export function filterNavItemsByPermissions(
  items: NavItem[],
  permissions: Iterable<string>,
  roleAssignments: RoleAssignment[] = [],
) {
  return items.filter((item) => canAccessNavHref(item.href, permissions, roleAssignments));
}

export function filterNavGroupsByPermissions(
  navGroups: NavGroup[],
  permissions: Iterable<string>,
  roleAssignments: RoleAssignment[] = [],
) {
  return navGroups
    .map((group) => ({
      ...group,
      items: filterNavItemsByPermissions(group.items, permissions, roleAssignments),
    }))
    .filter((group) => group.items.length > 0);
}
