"use client";

import { queryRefetchIntervals, queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { useApiQuery } from "./use-api-query";

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
