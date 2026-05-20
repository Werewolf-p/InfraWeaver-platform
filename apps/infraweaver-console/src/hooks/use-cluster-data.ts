"use client";

import { queryRefetchIntervals, queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type {
  ClusterNode,
  ClusterNodeCapacityInfo,
  ClusterNodeMetric,
  ClusterNodePodInfo,
  HorizontalPodAutoscalerSummary,
} from "@/types";
import { useApiQuery } from "./use-api-query";

export function useClusterNodes() {
  return useApiQuery<{ nodes: ClusterNode[] }>({
    queryKey: queryKeys.cluster.nodes(),
    path: "/api/cluster/nodes",
    staleTime: queryStaleTimes.short,
    refetchInterval: queryRefetchIntervals.minute,
  });
}

export function useClusterMetrics(refreshSeconds = 15) {
  return useApiQuery<{ metrics: ClusterNodeMetric[]; timestamp: string }>({
    queryKey: queryKeys.cluster.metrics(refreshSeconds),
    path: "/api/cluster/metrics",
    staleTime: queryStaleTimes.live,
    refetchInterval: refreshSeconds * 1000,
  });
}

export function useClusterHpas() {
  return useApiQuery<{ hpas: HorizontalPodAutoscalerSummary[] }>({
    queryKey: queryKeys.cluster.hpa(),
    path: "/api/cluster/hpa",
    staleTime: queryStaleTimes.short,
    refetchInterval: queryRefetchIntervals.minute,
  });
}

export function useClusterNodePods() {
  return useApiQuery<{ nodes: ClusterNodeCapacityInfo[]; pods: ClusterNodePodInfo[] }>({
    queryKey: queryKeys.cluster.nodePods(),
    path: "/api/cluster/node-pods",
    staleTime: 20_000,
    refetchInterval: queryRefetchIntervals.standard,
  });
}
