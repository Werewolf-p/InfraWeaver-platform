/**
 * Restore-drill analysis — PURE (unit-testable). Tracks whether a restore was
 * ever actually VERIFIED — the core DR-confidence metric. Backups you've never
 * test-restored are hope, not a recovery plan.
 */

export type DrillOutcome = "verified" | "failed" | "unverified";

export interface DrillEntry {
  id: string;
  volumeName: string;
  pvc: string;
  outcome: DrillOutcome;
  verifiedBy: string;
  note?: string;
  timestamp: string;
}

/** Days since the most recent VERIFIED restore across all volumes, or null if none ever verified. */
export function daysSinceLastVerifiedRestore(entries: DrillEntry[], nowMs: number): number | null {
  const verified = entries.filter((e) => e.outcome === "verified" && e.timestamp);
  if (verified.length === 0) return null;
  const latest = verified.reduce((max, e) => Math.max(max, new Date(e.timestamp).getTime()), 0);
  if (latest <= 0) return null;
  return Math.floor((nowMs - latest) / 86_400_000);
}

/** Most recent verified-restore timestamp per volume. */
export function lastVerifiedByVolume(entries: DrillEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.outcome !== "verified") continue;
    const existing = out[entry.volumeName];
    if (!existing || new Date(entry.timestamp).getTime() > new Date(existing).getTime()) {
      out[entry.volumeName] = entry.timestamp;
    }
  }
  return out;
}
