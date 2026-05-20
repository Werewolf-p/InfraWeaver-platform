"use client";

import { queryRefetchIntervals, queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { useApiMutation, useApiQuery } from "./use-api-query";

export interface AuditEntry {
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  details: string;
  result: "success" | "failure";
  ip?: string;
}

export function useAuditLog() {
  return useApiQuery<{ entries: AuditEntry[] }>({
    queryKey: queryKeys.security.auditLog(),
    path: "/api/security/audit-log",
    staleTime: queryStaleTimes.short,
    refetchInterval: queryRefetchIntervals.standard,
  });
}

export function useLogAction() {
  return useApiMutation<{ ok: boolean }, Partial<AuditEntry>>({
    path: "/api/security/audit-log",
    method: "POST",
    invalidateQueryKeys: [queryKeys.security.auditLog()],
    errorMessage: "Failed to log audit entry",
  });
}
