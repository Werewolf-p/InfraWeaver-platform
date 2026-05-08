"use client";
import { useSession } from "next-auth/react";
import { getRole, hasPermission, type Permission } from "@/lib/rbac";

export function useRBAC() {
  const { data: session } = useSession();
  const groups: string[] = (session?.user as any)?.groups ?? [];
  const role = getRole(groups);

  return {
    role,
    groups,
    can: (permission: Permission) => hasPermission(groups, permission),
    isAdmin: role === "admin",
    isOperator: role === "operator" || role === "admin",
  };
}
