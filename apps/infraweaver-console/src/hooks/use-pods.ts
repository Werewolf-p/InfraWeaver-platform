"use client";
import { useQuery } from "@tanstack/react-query";

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  nodeName?: string;
  createdAt: string;
}

export function usePods(namespace?: string) {
  return useQuery({
    queryKey: ["pods", namespace ?? "all"],
    queryFn: async () => {
      const url = namespace ? `/api/pods?namespace=${encodeURIComponent(namespace)}` : "/api/pods";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch pods");
      return res.json() as Promise<Pod[]>;
    },
    staleTime: 15000,
    refetchInterval: 30000,
  });
}
