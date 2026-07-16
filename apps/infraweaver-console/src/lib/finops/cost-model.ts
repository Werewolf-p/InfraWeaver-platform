/**
 * FinOps cost model — the single source of truth for resource pricing.
 *
 * The upstream `/cluster/cost` endpoint prices namespace REQUESTS at these same
 * rates (previously only echoed as a hardcoded stat-card string). Centralizing
 * them here lets the rightsizing engine and cost-attribution route attach a
 * dollar figure to reclaimable headroom without drifting from the cost page.
 *
 * Rates are per the homelab's own estimate (self-hosted, so these are
 * amortized-hardware proxies, not a cloud bill). Adjust in ONE place.
 */

/** USD per vCPU-hour (matches the /cluster/cost upstream estimate). */
export const CPU_USD_PER_VCPU_HR = 0.048;
/** USD per GB-hour of memory (matches the /cluster/cost upstream estimate). */
export const MEM_USD_PER_GB_HR = 0.006;
/** Hours in an average month (730 = 365 * 24 / 12), the billing convention. */
export const HOURS_PER_MONTH = 730;

/** Monthly USD for a sustained CPU reservation expressed in millicores. */
export function cpuMonthlyUsd(millicores: number): number {
  const vcpu = Math.max(0, millicores) / 1000;
  return vcpu * CPU_USD_PER_VCPU_HR * HOURS_PER_MONTH;
}

/** Monthly USD for a sustained memory reservation expressed in mebibytes. */
export function memoryMonthlyUsd(mebibytes: number): number {
  const gb = Math.max(0, mebibytes) * (1024 * 1024) / 1_000_000_000;
  return gb * MEM_USD_PER_GB_HR * HOURS_PER_MONTH;
}

/** Combined monthly USD for a CPU (millicores) + memory (MiB) reservation. */
export function resourceMonthlyUsd(cpuMillicores: number, memoryMiB: number): number {
  return cpuMonthlyUsd(cpuMillicores) + memoryMonthlyUsd(memoryMiB);
}

/** Human-readable rate footnote, derived from the constants (never hand-typed). */
export const COST_RATE_NOTE = `CPU: $${CPU_USD_PER_VCPU_HR}/vCPU/hr · Memory: $${MEM_USD_PER_GB_HR}/GB/hr`;
