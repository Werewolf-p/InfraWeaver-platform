"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

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
  return useQuery<{ entries: AuditEntry[] }>({
    queryKey: queryKeys.security.auditLog(),
    queryFn: async () => {
      const response = await fetch("/api/security/audit-log");
      if (!response.ok) throw new Error("Failed to fetch audit log");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useLogAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entry: Partial<AuditEntry>) => {
      const response = await fetch("/api/security/audit-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!response.ok) throw new Error("Failed to log audit entry");
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.security.auditLog() });
    },
  });
}
