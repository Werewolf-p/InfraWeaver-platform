/**
 * Health panel probe — a WordPress Site-Health-style checklist plus a versions
 * summary, all derived from live core `wp-cli` reads (WP_SAFE, so a broken plugin
 * cannot sink the read) and a couple of shell facts (a `.maintenance` flag, core
 * checksum verification). Every check is mapped to a good/recommended/critical
 * state with a plain-language detail. Read-only: no mutation is exposed here.
 */
import { WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, toNum, toStr, fieldStr } from "../wp-probe";
import { siteHealthSnapshot } from "../../iwsl-managed-ops";
import type { SiteHealthSnapshot } from "../site-health";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type CheckState = "good" | "recommended" | "critical";

export interface HealthCheck {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface HealthData {
  readonly wp: string | null;
  readonly php: string | null;
  readonly dbSizeMb: number | null;
  readonly checks: readonly HealthCheck[];
  readonly counts: { readonly good: number; readonly recommended: number; readonly critical: number };
  /**
   * The connector-backed Site Health aggregate (broken links, 404s, redirects,
   * maintenance) merged over the wp-cli checklist. Null on sites with no
   * commandable link, an outdated connector, or a transient signed-read failure —
   * the checklist above still renders (graceful degradation), which is why Free
   * sites keep working with no connector at all.
   */
  readonly siteHealth?: SiteHealthSnapshot | null;
}

/** wp-cli `cron event list` row. `type` (not interface) to stay Record-assignable. */
type CronRow = {
  next_run_relative?: string;
};

/** Common WordPress "truthy" config renderings from `wp config get`. */
function isTruthy(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Count WP-Cron events whose relative next-run reads as overdue ("... ago"). */
function countOverdue(cronJson: string): number {
  return parseJsonArray<CronRow>(cronJson).filter((row) => (fieldStr(row, "next_run_relative") ?? "").includes("ago"))
    .length;
}

/** Map a `core verify-checksums` transcript to a check. */
function integrityCheck(output: string): HealthCheck {
  const text = output.trim();
  if (text === "") {
    return {
      id: "integrity",
      label: "Core file integrity",
      state: "recommended",
      detail: "Could not verify core checksums (no response from WordPress.org).",
    };
  }
  const verified = /Success/i.test(text) && !/(doesn't|does not|should) verify/i.test(text);
  return verified
    ? { id: "integrity", label: "Core file integrity", state: "good", detail: "Core files verify against official checksums." }
    : { id: "integrity", label: "Core file integrity", state: "critical", detail: "One or more core files do not match official checksums." };
}

/** Grade the PHP runtime against WordPress's supported-version guidance. */
function phpCheck(php: string | null): HealthCheck {
  const major = php ? Number.parseFloat(php) : Number.NaN;
  if (!Number.isFinite(major)) {
    return { id: "php", label: "PHP version", state: "recommended", detail: "PHP version could not be determined." };
  }
  if (major >= 8.1) return { id: "php", label: "PHP version", state: "good", detail: `Running PHP ${php}.` };
  if (major >= 7.4) return { id: "php", label: "PHP version", state: "recommended", detail: `PHP ${php} is dated — upgrade to 8.1+.` };
  return { id: "php", label: "PHP version", state: "critical", detail: `PHP ${php} is end-of-life — upgrade urgently.` };
}

export function parseHealth(input: { scalars: string; cron: string; integrity: string }): HealthData {
  const kv = parseKv(input.scalars);
  const wp = toStr(kv.get("WP_VERSION"));
  const php = toStr(kv.get("PHP_VERSION"));
  const dbSizeMb = toNum(kv.get("DB_MB"));

  const coreUpdates = toInt(kv.get("CORE_UPDATES")) ?? 0;
  const pluginUpdates = toInt(kv.get("PLUGIN_UPDATES")) ?? 0;
  const cronTotal = toInt(kv.get("CRON_TOTAL")) ?? 0;
  const overdue = countOverdue(input.cron);
  const https = (kv.get("SITEURL") ?? "").trim().toLowerCase().startsWith("https:");
  const debug = isTruthy(kv.get("WP_DEBUG"));
  const maintenance = (kv.get("MAINTENANCE") ?? "").trim() === "present";

  const checks: HealthCheck[] = [
    {
      id: "core",
      label: "WordPress core",
      state: coreUpdates > 0 ? "critical" : "good",
      detail:
        coreUpdates > 0
          ? "A core update is available — apply it to stay secure."
          : `Running ${wp ?? "current"} — up to date.`,
    },
    integrityCheck(input.integrity),
    {
      id: "plugins",
      label: "Plugin updates",
      state: pluginUpdates > 0 ? "recommended" : "good",
      detail:
        pluginUpdates > 0
          ? `${pluginUpdates} plugin update${pluginUpdates === 1 ? "" : "s"} available.`
          : "All plugins are up to date.",
    },
    phpCheck(php),
    {
      id: "https",
      label: "HTTPS",
      state: https ? "good" : "critical",
      detail: https ? "Site URL is served over HTTPS." : "Site URL is not HTTPS — enable TLS.",
    },
    {
      id: "debug",
      label: "Debug mode",
      state: debug ? "recommended" : "good",
      detail: debug ? "WP_DEBUG is enabled — disable it in production." : "Debugging is disabled.",
    },
    {
      // This is the WordPress CORE-UPDATE LOCK (`.maintenance` file), distinct from
      // operator Maintenance mode (the branded holding page in the Maintenance
      // sub-section below). Relabelled so the two are never conflated.
      id: "maintenance",
      label: "Core update lock",
      state: maintenance ? "recommended" : "good",
      detail: maintenance
        ? "A .maintenance file is present — a core/plugin update may be mid-flight (the WordPress update lock, not operator maintenance mode)."
        : "No core update lock present (.maintenance file absent).",
    },
    {
      id: "cron",
      label: "Scheduled tasks",
      state: overdue > 0 ? "recommended" : "good",
      detail:
        overdue > 0
          ? `${overdue} overdue WP-Cron event${overdue === 1 ? "" : "s"} — cron may not be firing.`
          : `${cronTotal} scheduled event${cronTotal === 1 ? "" : "s"}, none overdue.`,
    },
  ];

  const counts = {
    good: checks.filter((c) => c.state === "good").length,
    recommended: checks.filter((c) => c.state === "recommended").length,
    critical: checks.filter((c) => c.state === "critical").length,
  };

  return { wp, php, dbSizeMb, checks, counts };
}

async function fetchHealth(ctx: PanelProbeContext): Promise<HealthData> {
  const scalarsCmd = [
    kvLine("WP_VERSION", `${WP_SAFE} core version`),
    kvLine("PHP_VERSION", `php -r 'echo PHP_VERSION;'`),
    kvLine("DB_MB", `${WP_SAFE} db size --size_format=mb`),
    kvLine("CORE_UPDATES", `${WP_SAFE} core check-update --format=count`),
    kvLine("PLUGIN_UPDATES", `${WP_SAFE} plugin list --update=available --format=count`),
    kvLine("CRON_TOTAL", `${WP_SAFE} cron event list --format=count`),
    kvLine("WP_DEBUG", `${WP_SAFE} config get WP_DEBUG`),
    kvLine("SITEURL", `${WP_SAFE} option get siteurl`),
    kvLine("MAINTENANCE", `test -f .maintenance && echo present || echo absent`),
  ].join("\n");

  const [scalars, cron, integrity, siteHealth] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP_SAFE} cron event list --fields=hook,next_run_relative --format=json`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx.exec(`${WP_SAFE} core verify-checksums 2>&1`).then((r) => r.stdout).catch(() => ""),
    // The one bounded signed aggregate — folded over the checklist. Any failure
    // (no link, old connector, transient) degrades to null; the checklist stays.
    fetchSiteHealthSnapshot(ctx),
  ]);

  return { ...parseHealth({ scalars, cron, integrity }), siteHealth };
}

/**
 * One signed `sitehealth.snapshot` read for the site, or null. Fails soft so the
 * wp-cli checklist never depends on the connector: unlinked sites, an outdated
 * connector (501) and transient exec/verify errors all resolve to null.
 */
async function fetchSiteHealthSnapshot(ctx: PanelProbeContext): Promise<SiteHealthSnapshot | null> {
  if (!ctx.managed) return null;
  return siteHealthSnapshot(ctx.site).catch(() => null);
}

export const healthProbe: PanelProbe<HealthData> = {
  id: "health",
  fetch: fetchHealth,
};
