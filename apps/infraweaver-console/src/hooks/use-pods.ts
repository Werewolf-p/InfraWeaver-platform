"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { KubernetesPod as Pod } from "@/types/kubernetes";

export type { Pod };

export function usePods(namespace?: string) {
  return useQuery<Pod[]>({
    queryKey: queryKeys.pods.list(namespace),
    queryFn: async () => {
      const url = namespace ? `/api/pods?namespace=${encodeURIComponent(namespace)}` : "/api/pods";
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch pods");
      return response.json();
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
