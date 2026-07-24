/**
 * Pure helpers for the Insights surface: translating the connector's honest gate
 * reasons to plain language (S9), and folding a React-Query result into a single
 * discriminated "view" the panels render. Framework-free and fully unit-tested so
 * the honest locked/upsell/connector-too-old/error states never drift.
 */

import type { InsightsGate } from "./insights";

/** The lowest tier that grants first-party analytics (stable per invariant). */
export const INSIGHTS_TIER_LABEL = "Ultimate";

/**
 * One rendered state for an insights read. `locked` carries the plain-language
 * reason + whether it is an upsell (tier gap) vs a transient/link condition, so
 * the panel can style the upsell distinctly and NEVER fabricate numbers.
 */
export type InsightsView<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "too-old" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "locked"; readonly reason: string; readonly upsell: boolean; readonly tier: string }
  | { readonly kind: "ready"; readonly data: T };

/** An error that preserves the HTTP status so 501 (connector too old) is distinguishable. */
export interface StatusError {
  readonly message: string;
  readonly status?: number;
}

/** Translate a single connector gate reason code to plain, honest language. */
export function gateReasonText(reason: string): string {
  switch (reason) {
    case "requires-plus":
      return `Traffic insights are an ${INSIGHTS_TIER_LABEL}-tier feature — upgrade the plan to unlock them.`;
    case "not-linked":
      return "The InfraWeaver Connector link isn't active on this site yet.";
    case "heartbeat-stale":
      return "Waiting for the site to check in — insights unlock after the next signed contact.";
    default:
      return "This feature is currently locked on the site.";
  }
}

/**
 * Pick the primary reason from a gate. `requires-plus` (the tier upsell) wins so
 * the operator is told what upgrading buys before transient link conditions.
 */
export function primaryGateReason(gate: InsightsGate | undefined): { text: string; upsell: boolean } {
  const reasons = gate?.reasons ?? [];
  if (reasons.includes("requires-plus")) {
    return { text: gateReasonText("requires-plus"), upsell: true };
  }
  const first = reasons.find((r) => r.length > 0);
  return { text: first ? gateReasonText(first) : "This feature is currently locked on the site.", upsell: false };
}

/** True when a thrown error was the connector's 501 "too old for this method" signal. */
export function isConnectorTooOld(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as StatusError).status === 501;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as StatusError).message === "string") {
    return (error as StatusError).message;
  }
  return "Insights could not be loaded.";
}

/**
 * Fold a query result + response into the single view a panel renders. A locked
 * response (`{ locked: true, gate }`) becomes an honest teaser with the gate's
 * real reason; a 501 becomes the connector-too-old state; anything else is either
 * loading, a retryable error, or the ready data.
 */
export function deriveInsightsView<T extends { locked: boolean; gate?: InsightsGate }>(input: {
  readonly isLoading: boolean;
  readonly data?: T;
  readonly error?: unknown;
}): InsightsView<T> {
  if (input.error) {
    if (isConnectorTooOld(input.error)) return { kind: "too-old" };
    return { kind: "error", message: errorMessage(input.error) };
  }
  if (input.data) {
    if (input.data.locked) {
      const { text, upsell } = primaryGateReason(input.data.gate);
      return { kind: "locked", reason: text, upsell, tier: INSIGHTS_TIER_LABEL };
    }
    return { kind: "ready", data: input.data };
  }
  if (input.isLoading) return { kind: "loading" };
  // No data, no error, not loading — treat as an empty/pending read.
  return { kind: "loading" };
}

/** Compact number for tiles (1_234 → "1.2k", 2_500_000 → "2.5M"). */
export function compactNumber(value: number): string {
  const n = Math.round(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Round a nullable delta to a whole percent, or null when there is no baseline. */
export function roundDelta(pct: number | null | undefined): number | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  return Math.round(pct);
}

/**
 * The privacy signals a summary's privacy block reports, as short chips. DNT + GPC
 * are always honored; the consent banner only when `consent_gated` is set.
 */
export function privacySignals(privacy: { dnt: number; gpc: number; consent_gated: number } | undefined): string[] {
  const out: string[] = [];
  if (!privacy) return out;
  if (privacy.dnt) out.push("DNT");
  if (privacy.gpc) out.push("GPC");
  if (privacy.consent_gated) out.push("consent banner");
  return out;
}
