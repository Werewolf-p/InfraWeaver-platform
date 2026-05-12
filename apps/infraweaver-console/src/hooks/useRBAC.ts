"use client";
import { useQuery } from "@tanstack/react-query";
import type { Permission } from "@/lib/rbac";

interface MyPermissions {
  email: string;
  legacyRole: string;
  permissions: string[];
  isAdmin: boolean;
}

export function useRBAC() {
  const { data, isLoading } = useQuery<MyPermissions>({
    queryKey: ["rbac", "my-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/rbac/my-permissions");
      if (!res.ok) throw new Error("Failed to load permissions");
      return res.json();
    },
    staleTime: 60_000,
  });

  function can(permission: Permission, scope = "/"): boolean {
    if (!data) return false;
    if (data.isAdmin || data.permissions.includes("*")) return true;
    return data.permissions.includes(permission);
  }

  return { can, isLoading, isAdmin: data?.isAdmin ?? false, permissions: data?.permissions ?? [] };
}
