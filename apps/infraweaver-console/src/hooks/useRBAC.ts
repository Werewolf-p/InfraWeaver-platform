"use client";

import { useMemo } from "react";
import { useSession } from "next-auth/react";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import {
  ALL_PERMISSIONS,
  getRole,
  hasAssignedPermissionForScope,
  hasPermission,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { useApiQuery } from "./use-api-query";

interface MyPermissions {
  email: string;
  legacyRole: string;
  assignments: RoleAssignment[];
  permissions: Permission[];
  isAdmin: boolean;
}

/**
 * Client-only gating fallback used when the /api/rbac/my-permissions fetch fails.
 * Deliberately narrowed to READ-ONLY permissions (and still further filtered by
 * the user's groups below) so a failed fetch can never widen the UI to
 * escalation-tier actions. The server remains the source of truth for every
 * mutating request. Derived from ALL_PERMISSIONS so new read verbs stay covered.
 */
const FALLBACK_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (permission) => permission !== "*" && permission.endsWith(":read"),
);

export function useRBAC() {
  const { data: session } = useSession();
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const legacyRole = getRole(groups);

  const { data, isLoading } = useApiQuery<MyPermissions>({
    queryKey: queryKeys.rbac.myPermissions(),
    path: "/api/rbac/my-permissions",
    staleTime: queryStaleTimes.minute,
  });

  // Memoize to prevent new references on every render (avoids infinite update loops in consumers)
  const groupKey = groups.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const permissions = useMemo<Permission[]>(() => data?.permissions ?? FALLBACK_PERMISSIONS.filter((p) => hasPermission(groups, p)), [data?.permissions, groupKey]);
  const assignments = useMemo<RoleAssignment[]>(() => data?.assignments ?? [], [data?.assignments]);
  const permissionSet = useMemo(() => new Set<string>(permissions), [permissions]);

  function can(permission: Permission, scope = "/") {
    if (permissionSet.has("*") || permissionSet.has(permission)) return true;
    if (scope === "/") return false;
    return hasAssignedPermissionForScope(assignments, permission, scope);
  }

  function canAny(required: Permission[], scope = "/") {
    return required.some((permission) => can(permission, scope));
  }

  return {
    role: data?.legacyRole ?? legacyRole,
    groups,
    permissions,
    assignments,
    can,
    canAny,
    isAdmin: data?.isAdmin ?? legacyRole === "admin",
    isOperator: legacyRole === "operator" || legacyRole === "admin",
    isLoading,
  };
}
