/**
 * Cost attribution — PURE. Splits each namespace's monthly spend into what it
 * actually USES vs the idle headroom it RESERVES (reclaimable). The cost page
 * previously showed request-based cost only, which can't answer "how much am I
 * paying for capacity nothing touches?".
 */

import { resourceMonthlyUsd } from "./cost-model";

export interface NamespaceResourceTotals {
  namespace: string;
  cpuM: number;
  memMi: number;
}

export interface NamespaceAttribution {
  namespace: string;
  requestedUsd: number;
  usedUsd: number;
  reclaimableUsd: number;
  utilizationPct: number;
}

export interface CostAttribution {
  namespaces: NamespaceAttribution[];
  totals: { requestedUsd: number; usedUsd: number; reclaimableUsd: number };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Join per-namespace REQUESTED totals against USED totals into a
 * requested/used/reclaimable dollar breakdown, sorted by reclaimable desc.
 */
export function attributeCost(requested: NamespaceResourceTotals[], used: NamespaceResourceTotals[]): CostAttribution {
  const usedByNs = new Map(used.map((u) => [u.namespace, u]));

  const namespaces = requested
    .map((req): NamespaceAttribution => {
      const use = usedByNs.get(req.namespace);
      const requestedUsd = resourceMonthlyUsd(req.cpuM, req.memMi);
      const usedUsd = use ? resourceMonthlyUsd(use.cpuM, use.memMi) : 0;
      // Used can exceed requests (burst above request), so clamp reclaimable at 0.
      const reclaimableUsd = Math.max(0, requestedUsd - usedUsd);
      return {
        namespace: req.namespace,
        requestedUsd: round2(requestedUsd),
        usedUsd: round2(usedUsd),
        reclaimableUsd: round2(reclaimableUsd),
        utilizationPct: requestedUsd > 0 ? Math.round((Math.min(usedUsd, requestedUsd) / requestedUsd) * 100) : 0,
      };
    })
    .sort((a, b) => b.reclaimableUsd - a.reclaimableUsd);

  const totals = namespaces.reduce(
    (acc, ns) => {
      acc.requestedUsd += ns.requestedUsd;
      acc.usedUsd += ns.usedUsd;
      acc.reclaimableUsd += ns.reclaimableUsd;
      return acc;
    },
    { requestedUsd: 0, usedUsd: 0, reclaimableUsd: 0 },
  );

  return {
    namespaces,
    totals: {
      requestedUsd: round2(totals.requestedUsd),
      usedUsd: round2(totals.usedUsd),
      reclaimableUsd: round2(totals.reclaimableUsd),
    },
  };
}
