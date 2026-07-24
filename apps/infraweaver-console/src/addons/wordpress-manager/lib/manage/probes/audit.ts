/**
 * SEO & A11y probe — ENGINE-AWARE. Composes the pure `parseAudit` core
 * (`audit-core.ts`) with the wp-cli exec + signed `seo.status` gather. The old
 * probe only understood Yoast and told a site running our OWN SEO Suite to
 * "Activate Yoast"; this MERGES the signed snapshot (which knows our suite + Pro
 * audit engines) OVER the third-party fallback, and DEGRADES GRACEFULLY when the
 * connector is too old for `seo.status` (`unknown-method` → 501 → `connectorTooOld`).
 *
 * Only ever imported server-side (via panel-data.ts); the panel imports the DATA
 * TYPES from `audit-core.ts` with `import type`, so this server-only transport never
 * leaks into a client bundle.
 */
import { WP, WP_SAFE } from "../wp-probe";
import { seoStatus } from "../../iwsl-managed-ops";
import { AddonHttpError } from "../../errors";
import type { SeoStatusResponse } from "../seo";
import { firstSeoSlug, activeSet, parseAudit, type AuditData } from "./audit-core";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type {
  AuditCategory,
  AuditData,
  AuditEngine,
  AuditFinding,
  AuditSeverity,
} from "./audit-core";
export { parseAudit } from "./audit-core";

// `\\\`` emits a literal backslash-backtick so the shell (inside the double-quoted
// SQL) treats the backtick as a MySQL identifier quote, not a command substitution;
// `$(wp … db prefix)` expands to the site's real table prefix.
const PREFIX = "$(wp --allow-root db prefix)";

function missingMetaSql(metaKey: string): string {
  return (
    `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` p ` +
    `LEFT JOIN \\\`${PREFIX}postmeta\\\` m ON p.ID=m.post_id AND m.meta_key='${metaKey}' ` +
    `WHERE p.post_type='post' AND p.post_status='publish' AND (m.meta_value IS NULL OR m.meta_value='')" ` +
    `--skip-column-names 2>/dev/null`
  );
}

const IMAGE_COUNT_SQL =
  `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` ` +
  `WHERE post_type='attachment' AND post_mime_type LIKE 'image/%'" --skip-column-names 2>/dev/null`;

const IMAGE_MISSING_ALT_SQL =
  `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` p ` +
  `LEFT JOIN \\\`${PREFIX}postmeta\\\` m ON p.ID=m.post_id AND m.meta_key='_wp_attachment_image_alt' ` +
  `WHERE p.post_type='attachment' AND p.post_mime_type LIKE 'image/%' AND (m.meta_value IS NULL OR m.meta_value='')" ` +
  `--skip-column-names 2>/dev/null`;

/** Read the signed `seo.status`; degrade to null (+ `connectorTooOld`) on any failure. */
async function readSeoStatus(site: string): Promise<{ status: SeoStatusResponse | null; connectorTooOld: boolean }> {
  try {
    return { status: await seoStatus(site), connectorTooOld: false };
  } catch (err) {
    // 501 = the connector predates the SEO command surface → prompt an update.
    const tooOld = err instanceof AddonHttpError && err.status === 501;
    return { status: null, connectorTooOld: tooOld };
  }
}

async function fetchAudit(ctx: PanelProbeContext): Promise<AuditData> {
  const activePlugins = await ctx
    .exec(`${WP} plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");

  const yoast = firstSeoSlug(activeSet(activePlugins)) === "wordpress-seo";

  // Signed snapshot first — it decides which fallback SQL (if any) we still need.
  const { status, connectorTooOld } = await readSeoStatus(ctx.site);
  const usePlatform =
    status?.engines.suite.unlocked === true || (status?.engines.audit.unlocked === true && status?.engines.audit.last != null);
  const needYoastSql = yoast && !usePlatform;

  const [publishedPosts, imageAttachments, imagesMissingAlt, missingMetadesc, missingFocusKw, titles] = await Promise.all([
    ctx
      .exec(`${WP_SAFE} post list --post_type=post --post_status=publish --format=count`)
      .then((r) => r.stdout)
      .catch(() => ""),
    // Alt counts only needed when the signed snapshot didn't provide them.
    status ? Promise.resolve("") : ctx.exec(IMAGE_COUNT_SQL).then((r) => r.stdout).catch(() => ""),
    status ? Promise.resolve("") : ctx.exec(IMAGE_MISSING_ALT_SQL).then((r) => r.stdout).catch(() => ""),
    needYoastSql ? ctx.exec(missingMetaSql("_yoast_wpseo_metadesc")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
    needYoastSql ? ctx.exec(missingMetaSql("_yoast_wpseo_focuskw")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
    needYoastSql
      ? ctx.exec(`${WP_SAFE} option get wpseo_titles --format=json 2>/dev/null`).then((r) => r.stdout).catch(() => "")
      : Promise.resolve(""),
  ]);

  return parseAudit({
    status,
    connectorTooOld,
    activePlugins,
    publishedPosts,
    imageAttachments,
    imagesMissingAlt,
    missingMetadesc,
    missingFocusKw,
    titles,
  });
}

export const auditProbe: PanelProbe<AuditData> = {
  id: "audit",
  requiresCapability: "seo",
  fetch: fetchAudit,
};
