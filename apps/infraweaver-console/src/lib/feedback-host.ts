import "server-only";

/**
 * Domain gate for the feedback REVIEW dashboard.
 *
 * The console image is reused verbatim for ephemeral preview deployments, so the
 * same code runs on both the canonical console host and on every preview host.
 * The Approve / Validate / Publish controls (and their mutating + run-log APIs)
 * must only ever be reachable on the canonical host — never inside a preview,
 * where an approval would recursively re-trigger the pipeline.
 *
 * The report/submit button stays available everywhere; only the review surface
 * is gated. Gate is host-based: compare the request Host against
 * FEEDBACK_DASHBOARD_HOST (default `infraweaver.int.rlservers.com`).
 */
const FEEDBACK_DASHBOARD_HOST = process.env.FEEDBACK_DASHBOARD_HOST ?? "infraweaver.int.rlservers.com";

/** Strip any `:port` and lowercase so `Host: foo:443` matches `foo`. */
function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").split(":")[0].trim().toLowerCase();
}

export function feedbackDashboardHost(): string {
  return normalizeHost(FEEDBACK_DASHBOARD_HOST);
}

/**
 * True when the request targets the canonical console host. Accepts a Headers
 * instance (route handlers) or a plain host string. Honours `x-forwarded-host`
 * (set by Traefik) ahead of `host`.
 */
export function isFeedbackHost(source: Headers | string | null | undefined): boolean {
  const canonical = feedbackDashboardHost();
  if (!canonical) return true; // unset → fail-open (single-host dev)

  let host: string | null | undefined;
  if (typeof source === "string" || source == null) {
    host = source;
  } else {
    host = source.get("x-forwarded-host") ?? source.get("host");
  }
  return normalizeHost(host) === canonical;
}
