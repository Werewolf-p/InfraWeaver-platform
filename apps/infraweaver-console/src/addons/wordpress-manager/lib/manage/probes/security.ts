/**
 * Security panel probe — a real posture checklist derived only from facts the site
 * can honestly answer over core `wp-cli`: core file integrity, core currency, admin
 * exposure (the well-known `admin` login + administrator headcount), the file-editor
 * hardening flag, defined auth salts, TLS on the site URL and debug-in-production.
 * Anything that would need a security plugin (WAF logs, malware sweeps, login
 * attempts) is deliberately omitted rather than faked. A 0–100 posture score is
 * computed from the checks. Read-only.
 */
import { WP_SAFE, kvLine, parseKv, toInt } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type CheckState = "good" | "recommended" | "critical";

export interface SecurityCheck {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface SecurityData {
  readonly checks: readonly SecurityCheck[];
  /** Computed posture score, 0–100. */
  readonly score: number;
  readonly adminCount: number;
  readonly counts: { readonly good: number; readonly recommended: number; readonly critical: number };
}

/** Common WordPress "truthy" config renderings from `wp config get`. */
function isTruthy(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Map a `core verify-checksums` transcript to a check. */
function integrityCheck(output: string): SecurityCheck {
  const text = output.trim();
  if (text === "") {
    return { id: "integrity", label: "Core file integrity", state: "recommended", detail: "Core checksums could not be verified." };
  }
  const verified = /Success/i.test(text) && !/(doesn't|does not|should) verify/i.test(text);
  return verified
    ? { id: "integrity", label: "Core file integrity", state: "good", detail: "Core files verify against official checksums." }
    : { id: "integrity", label: "Core file integrity", state: "critical", detail: "Core files do not match official checksums — possible compromise." };
}

/** Weight per state → averaged into a 0–100 posture score. */
function stateWeight(state: CheckState): number {
  if (state === "good") return 1;
  if (state === "recommended") return 0.5;
  return 0;
}

export function parseSecurity(input: { scalars: string; integrity: string }): SecurityData {
  const kv = parseKv(input.scalars);
  const adminCount = toInt(kv.get("ADMIN_COUNT")) ?? 0;
  const hasAdminUser = (kv.get("ADMIN_USER_ID") ?? "").trim() !== "";
  const coreUpdates = toInt(kv.get("CORE_UPDATES")) ?? 0;
  const fileEditDisabled = isTruthy(kv.get("DISALLOW_FILE_EDIT"));
  const saltsDefined = (toInt(kv.get("SALTS")) ?? 0) > 0;
  const https = (kv.get("SITEURL") ?? "").trim().toLowerCase().startsWith("https:");
  const debug = isTruthy(kv.get("WP_DEBUG"));

  const checks: SecurityCheck[] = [
    integrityCheck(input.integrity),
    {
      id: "core-current",
      label: "Core up to date",
      state: coreUpdates > 0 ? "critical" : "good",
      detail: coreUpdates > 0 ? "A core security update is pending — apply it now." : "WordPress core is on the latest release.",
    },
    {
      id: "default-admin",
      label: "Default 'admin' account",
      state: hasAdminUser ? "critical" : "good",
      detail: hasAdminUser ? "A user named 'admin' exists — a prime brute-force target." : "No account uses the well-known 'admin' login.",
    },
    {
      id: "admin-count",
      label: "Administrator accounts",
      state: adminCount > 3 ? "recommended" : "good",
      detail: `${adminCount} administrator account${adminCount === 1 ? "" : "s"}${adminCount > 3 ? " — review whether all still need full access." : "."}`,
    },
    {
      id: "file-editor",
      label: "File editor disabled",
      state: fileEditDisabled ? "good" : "recommended",
      detail: fileEditDisabled ? "DISALLOW_FILE_EDIT is set — the dashboard code editor is off." : "The plugin/theme file editor is enabled — set DISALLOW_FILE_EDIT.",
    },
    {
      id: "salts",
      label: "Security keys & salts",
      state: saltsDefined ? "good" : "critical",
      detail: saltsDefined ? "Authentication keys and salts are defined." : "Authentication salts are missing — define them in wp-config.php.",
    },
    {
      id: "ssl",
      label: "TLS / HTTPS",
      state: https ? "good" : "critical",
      detail: https ? "The site URL is served over HTTPS." : "The site URL is not HTTPS — traffic is unencrypted.",
    },
    {
      id: "debug",
      label: "Debug output",
      state: debug ? "recommended" : "good",
      detail: debug ? "WP_DEBUG is enabled in production — it can leak paths and errors." : "Debug output is disabled.",
    },
  ];

  const counts = {
    good: checks.filter((c) => c.state === "good").length,
    recommended: checks.filter((c) => c.state === "recommended").length,
    critical: checks.filter((c) => c.state === "critical").length,
  };
  const score = Math.round((checks.reduce((sum, c) => sum + stateWeight(c.state), 0) / checks.length) * 100);

  return { checks, score, adminCount, counts };
}

async function fetchSecurity(ctx: PanelProbeContext): Promise<SecurityData> {
  const scalarsCmd = [
    kvLine("ADMIN_COUNT", `${WP_SAFE} user list --role=administrator --format=count`),
    kvLine("ADMIN_USER_ID", `${WP_SAFE} user get admin --field=ID`),
    kvLine("CORE_UPDATES", `${WP_SAFE} core check-update --format=count`),
    kvLine("DISALLOW_FILE_EDIT", `${WP_SAFE} config get DISALLOW_FILE_EDIT`),
    kvLine("SALTS", `${WP_SAFE} config get AUTH_KEY | grep -c .`),
    kvLine("SITEURL", `${WP_SAFE} option get siteurl`),
    kvLine("WP_DEBUG", `${WP_SAFE} config get WP_DEBUG`),
  ].join("\n");

  const [scalars, integrity] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} core verify-checksums 2>&1`).then((r) => r.stdout).catch(() => ""),
  ]);

  return parseSecurity({ scalars, integrity });
}

export const securityProbe: PanelProbe<SecurityData> = {
  id: "security",
  fetch: fetchSecurity,
};
