"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type {
  ClusterNode,
  ClusterNodeCapacityInfo,
  ClusterNodeMetric,
  ClusterNodePodInfo,
  HorizontalPodAutoscalerSummary,
} from "@/types/cluster";

export function useClusterNodes() {
  return useQuery<{ nodes: ClusterNode[] }>({
    queryKey: queryKeys.cluster.nodes(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/nodes");
      if (!response.ok) throw new Error("Failed to fetch cluster nodes");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useClusterMetrics(refreshSeconds = 15) {
  return useQuery<{ metrics: ClusterNodeMetric[]; timestamp: string }>({
    queryKey: queryKeys.cluster.metrics(refreshSeconds),
    queryFn: async () => {
      const response = await fetch("/api/cluster/metrics");
      if (!response.ok) throw new Error("Failed to fetch cluster metrics");
      return response.json();
    },
    staleTime: 10_000,
    refetchInterval: refreshSeconds * 1000,
  });
}

export function useClusterHpas() {
  return useQuery<{ hpas: HorizontalPodAutoscalerSummary[] }>({
    queryKey: queryKeys.cluster.hpa(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/hpa");
      if (!response.ok) throw new Error("Failed to fetch HPAs");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useClusterNodePods() {
  return useQuery<{ nodes: ClusterNodeCapacityInfo[]; pods: ClusterNodePodInfo[] }>({
    queryKey: queryKeys.cluster.nodePods(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/node-pods");
      if (!response.ok) throw new Error("Failed to fetch node pod placement");
      return response.json();
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}
