"use client";

import { useCallback } from "react";
import { type Permission } from "@/lib/rbac";
import { useRBAC } from "./useRBAC";

export function usePermissions() {
  const rbac = useRBAC();

  const allowed = useCallback(
    (permission: Permission | Permission[], scope = "/") =>
      Array.isArray(permission) ? rbac.canAny(permission, scope) : rbac.can(permission, scope),
    [rbac],
  );

  return {
    ...rbac,
    allowed,
  };
}
