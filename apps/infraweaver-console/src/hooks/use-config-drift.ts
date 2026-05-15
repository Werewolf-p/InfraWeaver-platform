"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import type { ConfigDriftEntry } from "@/types/cluster";

interface ConfigDriftResponse {
  drift: ConfigDriftEntry[];
  baselineCaptured: boolean;
}

export function useConfigDrift() {
  const queryClient = useQueryClient();

  const query = useQuery<ConfigDriftResponse>({
    queryKey: queryKeys.cluster.configDrift(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/config-drift");
      if (!response.ok) throw new Error("Failed to load config drift");
      return response.json();
    },
    staleTime: 30_000,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.cluster.configDrift() });
  };

  const captureBaseline = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/cluster/config-drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "capture" }),
      });
      if (!response.ok) throw new Error("Failed to capture baseline");
      return response.json();
    },
    onSuccess: async () => {
      toast.success("Baseline captured");
      await invalidate();
    },
    onError: () => toast.error("Failed to capture baseline"),
  });

  const clearBaseline = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/cluster/config-drift", { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to clear baseline");
    },
    onSuccess: async () => {
      toast.success("Baseline cleared");
      await invalidate();
    },
    onError: () => toast.error("Failed to clear baseline"),
  });

  return {
    ...query,
    baselineCaptured: query.data?.baselineCaptured ?? false,
    drift: query.data?.drift ?? [],
    captureBaseline,
    clearBaseline,
  };
}
