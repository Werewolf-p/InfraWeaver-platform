import "server-only";
import { listItems, makeCustomApi } from "@/lib/kube-client";
import { errorMessage } from "@/lib/utils";
import type { ImageVulnReport, SeverityCounts } from "./vuln-rollup";

/**
 * Fetch Trivy Operator VulnerabilityReport CRDs and normalize to per-image CVE
 * counts. When the operator/CRD is absent, returns available:false so the UI
 * shows an "install Trivy" empty state — never fabricated CVE data.
 */

const TRIVY_GROUP = "aquasecurity.github.io";
const TRIVY_VERSION = "v1alpha1";
const TRIVY_PLURAL = "vulnerabilityreports";

interface TrivyReport {
  metadata?: { labels?: Record<string, string> };
  report?: {
    summary?: { criticalCount?: number; highCount?: number; mediumCount?: number; lowCount?: number; unknownCount?: number };
    artifact?: { repository?: string; tag?: string; digest?: string };
    registry?: { server?: string };
    updateTimestamp?: string;
  };
}

function crdAbsent(msg: string): boolean {
  return /the server could not find the requested resource|no matches for kind/i.test(msg);
}

type TrivySummary = NonNullable<NonNullable<TrivyReport["report"]>["summary"]>;

function countsOf(summary: TrivySummary | undefined): SeverityCounts {
  return {
    critical: summary?.criticalCount ?? 0,
    high: summary?.highCount ?? 0,
    medium: summary?.mediumCount ?? 0,
    low: summary?.lowCount ?? 0,
    unknown: summary?.unknownCount ?? 0,
  };
}

function imageOf(report: TrivyReport["report"]): string {
  const repository = report?.artifact?.repository ?? "";
  const server = report?.registry?.server ?? "";
  const tag = report?.artifact?.tag;
  const digest = report?.artifact?.digest;
  const base = server && !repository.startsWith(server) ? `${server}/${repository}` : repository;
  if (tag) return `${base}:${tag}`;
  if (digest) return `${base}@${digest}`;
  return base;
}

export async function fetchVulnerabilityReports(): Promise<{ reports: ImageVulnReport[]; available: boolean }> {
  try {
    const list = await makeCustomApi().listClusterCustomObject({ group: TRIVY_GROUP, version: TRIVY_VERSION, plural: TRIVY_PLURAL });
    const reports = listItems<TrivyReport>(list)
      .map((item): ImageVulnReport => ({
        image: imageOf(item.report),
        counts: countsOf(item.report?.summary),
        updatedAt: item.report?.updateTimestamp ?? null,
      }))
      .filter((r) => r.image);
    return { reports, available: true };
  } catch (err) {
    if (crdAbsent(errorMessage(err))) return { reports: [], available: false };
    return { reports: [], available: false };
  }
}
