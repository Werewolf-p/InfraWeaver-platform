// ─────────────────────────────────────────────────────────────────────────────
// Shared, non-seeded primitives for the fleet/manage demo widgets.
//
// These are the small, pure building blocks that the *real* components still
// depend on — status/severity unions, chart-point shapes, and the deterministic
// PRNG used by the (separate) per-site manage surface. They were extracted from
// the now-deleted `dummy-data.ts` so the surviving components no longer pull in
// any seeded/fake fleet data.
//
// Nothing here is fake data: these are types and one deterministic helper.
// ─────────────────────────────────────────────────────────────────────────────

/** Seeded, deterministic PRNG. Same seed → same sequence, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Status / severity unions (used by widgets.tsx and charts.tsx) ────────────
export type HealthStatus = "healthy" | "attention" | "critical" | "offline";

export type DayStatus = "up" | "degraded" | "down";

export type Severity = "critical" | "high" | "medium" | "low";

// ── Chart-point shapes (used by charts.tsx component signatures) ─────────────
export interface UpdatesPoint {
  readonly label: string;
  readonly core: number;
  readonly plugins: number;
  readonly themes: number;
}

export interface ResponsePoint {
  readonly t: string;
  readonly ms: number;
}

export interface BackupPoint {
  readonly day: string;
  readonly sizeGb: number;
}

export interface WafPoint {
  readonly t: string;
  readonly blocked: number;
}

export interface PerfPoint {
  readonly t: string;
  readonly mobile: number;
  readonly desktop: number;
}

export interface PhpPoint {
  readonly t: string;
  readonly errors: number;
}

export interface TrafficPoint {
  readonly t: string;
  readonly visitors: number;
}
