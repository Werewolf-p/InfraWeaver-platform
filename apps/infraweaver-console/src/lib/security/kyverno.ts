// ─────────────────────────────────────────────────────────────────────────────
// security/kyverno.ts — collect failing Kyverno PolicyReport results, replacing
// the three inline copies (policyreports + clusterpolicyreports in
// /api/security/kyverno, policyreports in /api/security/enhanced).
// ─────────────────────────────────────────────────────────────────────────────
import type * as k8s from "@kubernetes/client-node";
import type { KyvernoViolation } from "./types";

const KYVERNO_REPORT_GROUP = "wgpolicyk8s.io";
const KYVERNO_REPORT_VERSION = "v1alpha2";

export type KyvernoReportPlural = "policyreports" | "clusterpolicyreports";

interface PolicyReportResult {
  policy?: string;
  rule?: string;
  result?: string;
  severity?: string;
  category?: string;
  message?: string;
  resources?: Array<{ name?: string; kind?: string }>;
}

interface PolicyReport {
  metadata?: { namespace?: string };
  results?: PolicyReportResult[];
}

async function collectFromPlural(customApi: k8s.CustomObjectsApi, plural: KyvernoReportPlural): Promise<KyvernoViolation[]> {
  const violations: KyvernoViolation[] = [];
  try {
    const response = await customApi.listClusterCustomObject({
      group: KYVERNO_REPORT_GROUP,
      version: KYVERNO_REPORT_VERSION,
      plural,
    });
    const reports = ((response as { items?: unknown[] }).items ?? []) as PolicyReport[];
    for (const report of reports) {
      const namespace = plural === "clusterpolicyreports" ? "cluster" : report.metadata?.namespace ?? "";
      for (const result of report.results ?? []) {
        if (result.result !== "fail") continue;
        const resource = result.resources?.[0];
        violations.push({
          policy: result.policy ?? "unknown",
          namespace,
          resource: resource?.name ?? "unknown",
          kind: resource?.kind ?? "unknown",
          severity: result.severity ?? "medium",
          message: result.message ?? "",
          category: result.category ?? "Other",
          ...(result.rule ? { rule: result.rule } : {}),
        });
      }
    }
  } catch {
    // PolicyReport CRDs may not be installed — treat as no violations.
  }
  return violations;
}

/**
 * Collect failing ("fail") Kyverno PolicyReport results as violations.
 * Defaults to BOTH namespaced policyreports and clusterpolicyreports (the
 * latter reported under namespace "cluster", matching /api/security/kyverno);
 * pass `opts.plural` to restrict to one kind (as /api/security/enhanced does).
 * Missing CRDs never throw — they simply contribute nothing.
 */
export async function collectKyvernoViolations(
  customApi: k8s.CustomObjectsApi,
  opts: { plural?: KyvernoReportPlural } = {},
): Promise<KyvernoViolation[]> {
  const plurals: KyvernoReportPlural[] = opts.plural ? [opts.plural] : ["policyreports", "clusterpolicyreports"];
  const collected = await Promise.all(plurals.map((plural) => collectFromPlural(customApi, plural)));
  return collected.flat();
}
