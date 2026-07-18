import "server-only";
import { listExternalSites, type ExternalSiteRecord } from "./iwsl-link-store";
import { rotateConnectorKey } from "./iwsl-managed-ops";

/**
 * §8 automated key reroll (server-driven, daily CronJob).
 *
 * Signing keys shouldn't live forever. This sweep rerolls managed links whose
 * current key is older than a threshold, reusing the exact same PREPARE → VERIFY
 * → CONFIRM driver the manual "Reroll key" button uses — so the safety
 * properties are unchanged: a reroll that can't be verified under the new epoch
 * keeps the OLD key live and is retried on a later run (idempotent, keyed on
 * rotation_id). Two guardrails keep it from being a fleet-wide footgun:
 *   1. Only keys past `IWSL_ROTATION_MAX_AGE_DAYS` are touched — freshly enrolled
 *      links are anchored on their enrollment time, so nothing rotates the day it
 *      deploys; each site ages independently, spreading the load naturally.
 *   2. At most `IWSL_ROTATION_MAX_PER_RUN` links roll per run (oldest first, plus
 *      any already-in-flight rotation resumed first), so a bad batch can't take
 *      the whole fleet's signing path at once.
 * Identity-suspended, quarantined, unconfirmed, or non-managed links are skipped
 * outright (they can't be safely commanded).
 */

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_PER_RUN = 2;
/**
 * Hard ceiling on how many links can roll in one run, independent of config.
 * The env var TUNES the cap; it must not be able to NULLIFY it — a safety
 * control gating live-key rotation can't be defeated by the same knob meant to
 * adjust it. A run needing more than this just spreads across more runs.
 */
const HARD_MAX_PER_RUN = 10;
/** Floor on the age threshold so a tiny/zero env can't turn the sweep into rotate-everything. */
const MIN_AGE_DAYS = 1;
const MS_PER_DAY = 86_400_000;

function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function rotationMaxAgeMs(): number {
  const days = Math.max(MIN_AGE_DAYS, positiveEnvNumber(process.env.IWSL_ROTATION_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS));
  return days * MS_PER_DAY;
}

function rotationMaxPerRun(): number {
  return Math.min(HARD_MAX_PER_RUN, Math.floor(positiveEnvNumber(process.env.IWSL_ROTATION_MAX_PER_RUN, DEFAULT_MAX_PER_RUN)));
}

/**
 * Age of a link's current signing key: time since its last reroll, or since
 * enrollment if it has never rerolled. A record with neither timestamp is
 * treated as maximally old so a legacy link without provenance still rotates.
 */
export function keyAgeMs(site: ExternalSiteRecord, now: number): number {
  const anchorIso = site.lastReroll?.at ?? site.activatedAt;
  if (!anchorIso) return Number.POSITIVE_INFINITY;
  const anchoredTs = Date.parse(anchorIso);
  if (Number.isNaN(anchoredTs)) return Number.POSITIVE_INFINITY;
  // Clamp at 0: a future-dated anchor (clock skew / clone) must not yield a
  // negative age that would exclude the site from rotation forever.
  return Math.max(0, now - anchoredTs);
}

export interface RotationCandidate {
  siteId: string;
  siteName: string;
  ageMs: number;
  /** True when this link already has a rotation in flight and is being resumed. */
  resuming: boolean;
}

/**
 * Pure selection of which managed links to reroll this run. Exported so the
 * eligibility rules are unit-testable without a cluster.
 */
export function selectRotationCandidates(
  sites: ExternalSiteRecord[],
  opts: { now: number; maxAgeMs: number; maxPerRun: number },
): RotationCandidate[] {
  const eligible = sites.filter(
    (s): s is ExternalSiteRecord & { siteName: string } =>
      Boolean(s.managed) &&
      typeof s.siteName === "string" &&
      s.state === "active" &&
      s.fingerprintConfirmed &&
      !s.identitySuspended &&
      // A rotation in flight is always worth resuming; otherwise gate on age.
      (Boolean(s.pendingRotation) || keyAgeMs(s, opts.now) >= opts.maxAgeMs),
  );

  return eligible
    .map((s) => ({
      siteId: s.siteId,
      siteName: s.siteName,
      ageMs: keyAgeMs(s, opts.now),
      resuming: Boolean(s.pendingRotation),
    }))
    // Resume in-flight rotations first (finish what was started), then oldest key.
    .sort((a, b) => Number(b.resuming) - Number(a.resuming) || b.ageMs - a.ageMs)
    .slice(0, Math.max(0, opts.maxPerRun));
}

export interface RotationSweepResult {
  site: string;
  ageDays: number;
  resuming: boolean;
  outcome: "confirmed" | "aborted" | "pending" | "error";
  kid?: number;
  error?: string;
}

export interface RotationSweepSummary {
  ranAt: string;
  /** Total managed links considered. */
  scanned: number;
  /** How many were eligible this run (capped set actually attempted). */
  attempted: number;
  /** How many completed a full reroll (outcome "confirmed"). */
  rotated: number;
  results: RotationSweepResult[];
}

export async function runRotationSweep(now = Date.now()): Promise<RotationSweepSummary> {
  const sites = await listExternalSites();
  const candidates = selectRotationCandidates(sites, {
    now,
    maxAgeMs: rotationMaxAgeMs(),
    maxPerRun: rotationMaxPerRun(),
  });

  // Bounded (<= maxPerRun); each rotation persists via mutateExternalSites, which
  // is now conflict/transient-retry safe, so running them concurrently is fine.
  const settled = await Promise.allSettled(candidates.map((c) => rotateConnectorKey(c.siteName)));

  const results: RotationSweepResult[] = settled.map((outcome, i) => {
    const c = candidates[i];
    const ageDays = Number.isFinite(c.ageMs) ? Math.floor(c.ageMs / MS_PER_DAY) : -1;
    const base = { site: c.siteName, ageDays, resuming: c.resuming };
    if (outcome.status === "fulfilled") {
      return { ...base, outcome: outcome.value.outcome, kid: outcome.value.kid };
    }
    const reason = outcome.reason;
    return { ...base, outcome: "error", error: reason instanceof Error ? reason.message : String(reason) };
  });

  return {
    ranAt: new Date(now).toISOString(),
    scanned: sites.filter((s) => s.managed).length,
    attempted: candidates.length,
    rotated: results.filter((r) => r.outcome === "confirmed").length,
    results,
  };
}
