"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

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
    queryKey: ["security", "audit-log"],
    queryFn: async () => {
      const r = await fetch("/api/security/audit-log");
      if (!r.ok) throw new Error("Failed to fetch audit log");
      return r.json();
    },
    staleTime: 30000,
    refetchInterval: 30000,
  });
}

export function useLogAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entry: Partial<AuditEntry>) => {
      const r = await fetch("/api/security/audit-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!r.ok) throw new Error("Failed to log audit entry");
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["security", "audit-log"] });
    },
  });
}
