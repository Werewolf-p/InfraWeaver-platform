/**
 * Image CVE rollup — PURE (unit-testable). Joins Trivy VulnerabilityReport
 * summaries against running images and ranks by severity × exposure.
 */

import type { RunningImage } from "./supply-chain";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface ImageVulnReport {
  image: string;
  counts: SeverityCounts;
  updatedAt: string | null;
}

export interface ImageMatrixRow {
  image: string;
  registry: string;
  pods: number;
  namespaces: string[];
  counts: SeverityCounts;
  scanned: boolean;
  updatedAt: string | null;
  riskScore: number;
}

export interface VulnRollup {
  totals: SeverityCounts;
  scanned: number;
  unscanned: number;
  coveragePct: number;
  worstOffenders: ImageMatrixRow[];
  grade: "A" | "B" | "C" | "D" | "F";
  riskScore: number;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 25, medium: 5, low: 1, unknown: 0 };
export const WORST_OFFENDERS_TOP_N = 10;
/** A Trivy report older than this is stale — gives false confidence. */
export const SCAN_STALE_HOURS = 24;

export interface ScanCoverage {
  coveragePct: number;
  unscanned: ImageMatrixRow[];
  staleScans: ImageMatrixRow[];
}

/** Blind spots: running images with no report (unscanned) or a report older than SCAN_STALE_HOURS (stale). */
export function assessScanCoverage(matrix: ImageMatrixRow[], nowMs: number): ScanCoverage {
  const staleBeforeMs = nowMs - SCAN_STALE_HOURS * 3_600_000;
  const unscanned = matrix.filter((row) => !row.scanned);
  const staleScans = matrix.filter((row) => row.scanned && row.updatedAt !== null && new Date(row.updatedAt).getTime() < staleBeforeMs);
  const coveragePct = matrix.length > 0 ? Math.round(((matrix.length - unscanned.length) / matrix.length) * 100) : 100;
  return { coveragePct, unscanned, staleScans };
}

const ZERO: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

/** Normalize an image ref for joining running images to Trivy reports (registry aliases differ). */
export function normalizeImageRef(image: string): string {
  return image
    .trim()
    .toLowerCase()
    .replace(/^(index\.)?docker\.io\//, "")
    .replace(/^registry-1\.docker\.io\//, "")
    .replace(/^library\//, "");
}

/** Weighted risk for one image: severity weight × exposure (pods). */
export function imageRiskScore(counts: SeverityCounts, pods: number): number {
  const base = counts.critical * SEVERITY_WEIGHT.critical + counts.high * SEVERITY_WEIGHT.high + counts.medium * SEVERITY_WEIGHT.medium + counts.low * SEVERITY_WEIGHT.low;
  return base * Math.max(1, pods);
}

/** Join running images with their Trivy reports (unscanned images kept, flagged). */
export function buildImageMatrix(running: RunningImage[], reports: ImageVulnReport[]): ImageMatrixRow[] {
  const reportByImage = new Map(reports.map((r) => [normalizeImageRef(r.image), r]));
  return running
    .map((img): ImageMatrixRow => {
      const report = reportByImage.get(normalizeImageRef(img.image));
      const counts = report?.counts ?? { ...ZERO };
      return {
        image: img.image,
        registry: img.registry,
        pods: img.pods,
        namespaces: img.namespaces,
        counts,
        scanned: report !== undefined,
        updatedAt: report?.updatedAt ?? null,
        riskScore: report ? imageRiskScore(counts, img.pods) : 0,
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore);
}

function gradeFromScore(score: number): VulnRollup["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function rollupImageVulns(matrix: ImageMatrixRow[], topN: number = WORST_OFFENDERS_TOP_N): VulnRollup {
  const totals = { ...ZERO };
  let scanned = 0;
  for (const row of matrix) {
    if (row.scanned) scanned += 1;
    totals.critical += row.counts.critical;
    totals.high += row.counts.high;
    totals.medium += row.counts.medium;
    totals.low += row.counts.low;
    totals.unknown += row.counts.unknown;
  }
  const total = matrix.length;
  const unscanned = total - scanned;
  const coveragePct = total > 0 ? Math.round((scanned / total) * 100) : 100;

  // Grade off critical/high density + scan coverage.
  const critHigh = totals.critical * 3 + totals.high;
  const score = Math.max(0, 100 - critHigh * 2 - unscanned * 3);

  return {
    totals,
    scanned,
    unscanned,
    coveragePct,
    worstOffenders: matrix.filter((r) => r.riskScore > 0).slice(0, topN),
    grade: gradeFromScore(score),
    riskScore: score,
  };
}
