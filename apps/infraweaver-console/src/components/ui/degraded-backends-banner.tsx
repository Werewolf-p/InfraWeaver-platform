"use client";

import { AlertTriangle } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";

interface CircuitStatus {
  name: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  nextAttemptAt: number | null;
}

/**
 * Amber banner listing backends whose circuit breaker is OPEN — so a hard-down
 * dependency (ArgoCD, Prometheus…) reads as "backing off" instead of silently
 * failing every query. Renders nothing when all circuits are healthy.
 */
export function DegradedBackendsBanner() {
  const { data } = useApiQuery<{ circuits: CircuitStatus[] }>({
    queryKey: ["health", "circuits"],
    path: "/api/health/circuits",
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const open = (data?.circuits ?? []).filter((c) => c.state !== "CLOSED");
  if (open.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300" role="status">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        Degraded backend{open.length > 1 ? "s" : ""}: {open.map((c) => c.name).join(", ")} — backing off, some data may be stale.
      </span>
    </div>
  );
}
