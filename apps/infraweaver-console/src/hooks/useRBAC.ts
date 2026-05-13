"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import {
  getRole,
  hasAssignedPermissionForScope,
  hasPermission,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";

interface MyPermissions {
  email: string;
  legacyRole: string;
  assignments: RoleAssignment[];
  permissions: Permission[];
  isAdmin: boolean;
}

const FALLBACK_PERMISSIONS: Permission[] = [
  "apps:read",
  "apps:write",
  "apps:sync",
  "apps:delete",
  "config:read",
  "config:write",
  "catalog:write",
  "catalog:delete",
  "users:read",
  "users:write",
  "users:invite",
  "cluster:read",
  "cluster:drain",
  "cluster:scale",
  "cluster:admin",
  "security:read",
  "security:write",
  "nas:read",
  "nas:write",
  "infra:read",
  "rbac:admin",
  "game-hub:read",
  "game-hub:write",
  "game-hub:admin",
  "game-hub:players",
  "game-hub:console",
  "game-hub:files",
  "game-hub:start",
  "game-hub:stop",
  "game-hub:scale",
];

export function useRBAC() {
  const { data: session } = useSession();
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const legacyRole = getRole(groups);

  const { data, isLoading } = useQuery<MyPermissions>({
    queryKey: ["rbac", "my-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/rbac/my-permissions");
      if (!res.ok) throw new Error("Failed to load permissions");
      return res.json();
    },
    staleTime: 60_000,
  });

  const permissions = data?.permissions ?? FALLBACK_PERMISSIONS.filter((permission) => hasPermission(groups, permission));
  const assignments = data?.assignments ?? [];
  const permissionSet = new Set<string>(permissions);

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
