/**
 * Rightsizing engine — PURE (no k8s imports, unit-testable).
 *
 * Replaces the old resource-recommendations stub that always returned
 * `status: "optimal"` and `recommended === request`. Real rightsizing joins a
 * container's REQUESTED resources against its ACTUAL usage (metrics-server) and
 * recommends a new request with a fixed headroom margin, attaching a dollar
 * figure to reclaimable over-provisioning via the shared cost model.
 */

import { resourceMonthlyUsd } from "./cost-model";

/** usage/request below this fraction ⇒ over-provisioned (paying for idle headroom). */
export const OVER_UTIL_PCT = 0.4;
/** usage/request above this fraction ⇒ under-provisioned (throttle/OOM risk). */
export const UNDER_UTIL_PCT = 0.9;
/** Recommended request = observed usage × this margin. */
export const HEADROOM_FACTOR = 1.25;
/** Never recommend a CPU request below this (millicores). */
export const MIN_CPU_M = 10;
/** Never recommend a memory request below this (MiB). */
export const MIN_MEM_MI = 16;

export type RightsizingStatus = "over" | "under" | "optimal" | "no-metrics";

export interface ContainerUsage {
  namespace: string;
  pod: string;
  container: string;
  requestCpuM: number;
  usageCpuM: number;
  requestMemMi: number;
  usageMemMi: number;
  hasMetrics: boolean;
}

export interface RightsizingRec {
  namespace: string;
  pod: string;
  container: string;
  requestCpuM: number;
  usageCpuM: number;
  recommendedCpuM: number;
  requestMemMi: number;
  usageMemMi: number;
  recommendedMemMi: number;
  status: RightsizingStatus;
  /** Monthly USD reclaimable if the over-provisioned request is trimmed to the recommendation. */
  monthlyWasteUsd: number;
}

export interface RightsizingSummary {
  analyzed: number;
  overCount: number;
  underCount: number;
  optimalCount: number;
  noMetricsCount: number;
  totalMonthlyWasteUsd: number;
}

type Dim = { request: number; usage: number; min: number };

/** Per-resource verdict: recommended value + whether it is over/under/optimal. */
function assessDim({ request, usage, min }: Dim): { recommended: number; verdict: "over" | "under" | "optimal" } {
  // Usage exists but no request declared ⇒ under-provisioned (request should be set).
  if (request <= 0) {
    if (usage <= 0) return { recommended: 0, verdict: "optimal" };
    return { recommended: Math.max(min, Math.round(usage * HEADROOM_FACTOR)), verdict: "under" };
  }
  const ratio = usage / request;
  if (ratio > UNDER_UTIL_PCT) {
    return { recommended: Math.max(request, Math.round(usage * HEADROOM_FACTOR)), verdict: "under" };
  }
  if (ratio < OVER_UTIL_PCT) {
    const recommended = Math.min(request, Math.max(min, Math.round(usage * HEADROOM_FACTOR)));
    return { recommended, verdict: "over" };
  }
  return { recommended: request, verdict: "optimal" };
}

/** Combined status precedence: under (risk) > over (waste) > optimal. */
function combineVerdicts(cpu: "over" | "under" | "optimal", mem: "over" | "under" | "optimal"): RightsizingStatus {
  if (cpu === "under" || mem === "under") return "under";
  if (cpu === "over" || mem === "over") return "over";
  return "optimal";
}

/** Classify one container's requests vs usage into a rightsizing recommendation. */
export function assessContainer(input: ContainerUsage): RightsizingRec {
  const base = {
    namespace: input.namespace,
    pod: input.pod,
    container: input.container,
    requestCpuM: input.requestCpuM,
    usageCpuM: input.usageCpuM,
    requestMemMi: input.requestMemMi,
    usageMemMi: input.usageMemMi,
  };

  if (!input.hasMetrics) {
    return {
      ...base,
      recommendedCpuM: input.requestCpuM,
      recommendedMemMi: input.requestMemMi,
      status: "no-metrics",
      monthlyWasteUsd: 0,
    };
  }

  const cpu = assessDim({ request: input.requestCpuM, usage: input.usageCpuM, min: MIN_CPU_M });
  const mem = assessDim({ request: input.requestMemMi, usage: input.usageMemMi, min: MIN_MEM_MI });
  const status = combineVerdicts(cpu.verdict, mem.verdict);

  // Waste = reclaimable request on the dimensions that are over-provisioned.
  const wasteCpuM = cpu.verdict === "over" ? Math.max(0, input.requestCpuM - cpu.recommended) : 0;
  const wasteMemMi = mem.verdict === "over" ? Math.max(0, input.requestMemMi - mem.recommended) : 0;
  const monthlyWasteUsd = resourceMonthlyUsd(wasteCpuM, wasteMemMi);

  return {
    ...base,
    recommendedCpuM: cpu.recommended,
    recommendedMemMi: mem.recommended,
    status,
    monthlyWasteUsd: Math.round(monthlyWasteUsd * 100) / 100,
  };
}

/** Classify a batch of containers and roll up a summary. */
export function assessContainers(inputs: ContainerUsage[]): { recommendations: RightsizingRec[]; summary: RightsizingSummary } {
  const recommendations = inputs.map(assessContainer);
  const summary = recommendations.reduce<RightsizingSummary>(
    (acc, rec) => {
      acc.analyzed += 1;
      if (rec.status === "over") acc.overCount += 1;
      else if (rec.status === "under") acc.underCount += 1;
      else if (rec.status === "optimal") acc.optimalCount += 1;
      else acc.noMetricsCount += 1;
      acc.totalMonthlyWasteUsd += rec.monthlyWasteUsd;
      return acc;
    },
    { analyzed: 0, overCount: 0, underCount: 0, optimalCount: 0, noMetricsCount: 0, totalMonthlyWasteUsd: 0 },
  );
  summary.totalMonthlyWasteUsd = Math.round(summary.totalMonthlyWasteUsd * 100) / 100;
  // Surface the most actionable first: biggest waste, then under-provisioned risk.
  recommendations.sort((a, b) => b.monthlyWasteUsd - a.monthlyWasteUsd || rank(b.status) - rank(a.status));
  return { recommendations, summary };
}

function rank(status: RightsizingStatus): number {
  return status === "under" ? 3 : status === "over" ? 2 : status === "optimal" ? 1 : 0;
}
