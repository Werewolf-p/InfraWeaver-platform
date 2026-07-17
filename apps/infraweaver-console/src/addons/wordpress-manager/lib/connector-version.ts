/**
 * Pure "update available" compare for the Connector version badge (§5.1 interim,
 * see docs/iwsl-signed-plugin-update.md recommendation 2). No `server-only`
 * import: this runs in the client cards too.
 *
 * The `current` version fed here always originates from a signature-VERIFIED
 * `health.check` (iwsl-managed-ops.connectorHealthCheck / updateConnectorPlugin
 * persist `connectorVersion` only after dispatchSignedCommand has checked the
 * response against the pinned WP-PK). A machine-in-the-middle therefore cannot
 * forge a matching version to hide an out-of-date connector: a response whose
 * signature fails quarantines the link instead of updating the stored version.
 * So a rendered "update available" pill is only ever suppressed by a genuine,
 * plugin-signed version — never by a spoofed one.
 */

/**
 * True only when `bundled` is strictly newer than `current`. A site running a
 * version AHEAD of the console bundle (or either version unparseable/missing) is
 * not flagged — the badge must never nag about a difference the operator can't
 * act on with the bundled package.
 */
export function isConnectorOutdated(
  current: string | undefined | null,
  bundled: string | undefined | null,
): boolean {
  const cmp = compareConnectorVersions(current, bundled);
  return cmp !== null && cmp < 0;
}

/**
 * -1 | 0 | 1 comparing `a` to `b` over their leading dotted-numeric cores, or
 * null when either is missing or has no parseable numeric core.
 */
export function compareConnectorVersions(
  a: string | undefined | null,
  b: string | undefined | null,
): number | null {
  const pa = parseSegments(a);
  const pb = parseSegments(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Leading dotted-numeric core (e.g. `[1,4,0]` from `"1.4.0-beta.2"`); null if none. */
function parseSegments(version: string | undefined | null): number[] | null {
  if (typeof version !== "string") return null;
  const core = version.trim().split(/[-+]/)[0];
  if (core === "") return null;
  const segments = core.split(".").map((segment) => Number(segment));
  if (segments.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return segments;
}
