/**
 * Email panel probe — the MERGED delivery read model. Primary source is the
 * connector's OWN SMTP feature, read over the signed channel (`email.config.get`
 * + `email.log.get`); the third-party SMTP-plugin posture (WP Mail SMTP / Post
 * SMTP, read one non-secret field at a time via `wp option pluck`) is kept as the
 * fallback for un-enrolled/unentitled sites AND for conflict detection when a
 * plugin is active alongside connector delivery.
 *
 * This replaces the old probe that only read a third-party plugin and recommended
 * installing wp-mail-smtp — a competitor to our own gated `email_delivery`
 * feature. The connector path now leads.
 *
 * SECURITY: the SMTP password is never read on either path. The signed channel
 * returns a STRIPPED snapshot (the engine drops the secret); the plugin path
 * `pluck`s only non-secret posture leaves, so the sibling credential in the same
 * option is never read into console memory. `EmailData` (in lib/manage/email.ts)
 * has no field that could carry a secret to the browser.
 */
import { getEmailConfig, getEmailLog } from "../../iwsl-managed-ops";
import {
  buildPluginPosture,
  mergeEmailData,
  type EmailConnectorConfig,
  type EmailData,
  type EmailLogResponse,
  type EmailPluginPosture,
  type EmailPluginPostureFields,
} from "../email";
import { WP_SAFE, activePluginSlugs } from "../wp-probe";
import { SMTP_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Slugs whose single-option config we can decode. */
const WP_MAIL_SMTP_SLUG = "wp-mail-smtp";
const POST_SMTP_SLUG = "post-smtp";

type EmailPosture = EmailPluginPostureFields;

/** Trim a plucked scalar; empty (missing key / read failure) → null. */
function strOrNull(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  return t === "" ? null : t;
}

/** Coerce a plucked scalar to a finite number, or null. */
function numOrNull(raw: string | null): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a plucked scalar to a boolean; empty / unrecognised → null (unknown). */
function boolOrNull(raw: string | null): boolean | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "1" || t === "true" || t === "yes") return true;
  if (t === "0" || t === "false" || t === "no") return false;
  return null;
}

/**
 * Read one leaf of an option via `wp option pluck <option> <key...>` — walks the
 * nested key path and prints only that scalar, so a sibling secret in the same
 * option is never emitted. Missing key or a failed read → null. Only static
 * literals are ever interpolated here (option name + fixed key path), so there is
 * no injectable input on this command line.
 */
async function pluck(ctx: PanelProbeContext, option: string, ...keys: string[]): Promise<string | null> {
  return ctx
    .exec(`${WP_SAFE} option pluck ${option} ${keys.join(" ")}`)
    .then((r) => strOrNull(r.stdout))
    .catch(() => null);
}

/** WP Mail SMTP stores `{ mail: { mailer, from_email, from_name }, smtp: { host, port, encryption, auth, pass } }`. */
async function readWpMailSmtp(ctx: PanelProbeContext): Promise<EmailPosture> {
  const [mailer, fromEmail, fromName, host, port, encryption, auth] = await Promise.all([
    pluck(ctx, "wp_mail_smtp", "mail", "mailer"),
    pluck(ctx, "wp_mail_smtp", "mail", "from_email"),
    pluck(ctx, "wp_mail_smtp", "mail", "from_name"),
    pluck(ctx, "wp_mail_smtp", "smtp", "host"),
    pluck(ctx, "wp_mail_smtp", "smtp", "port"),
    pluck(ctx, "wp_mail_smtp", "smtp", "encryption"),
    pluck(ctx, "wp_mail_smtp", "smtp", "auth"),
  ]);
  return { mailer, host, port: numOrNull(port), encryption, auth: boolOrNull(auth), fromEmail, fromName };
}

/** Post SMTP stores a flat `postman_options` (password lives under `basic_auth_password`). */
async function readPostSmtp(ctx: PanelProbeContext): Promise<EmailPosture> {
  const [mailer, host, port, encryption, authType, fromEmail, fromName] = await Promise.all([
    pluck(ctx, "postman_options", "transport_type"),
    pluck(ctx, "postman_options", "hostname"),
    pluck(ctx, "postman_options", "port"),
    pluck(ctx, "postman_options", "enc_type"),
    pluck(ctx, "postman_options", "auth_type"),
    pluck(ctx, "postman_options", "sender_email"),
    pluck(ctx, "postman_options", "sender_name"),
  ]);
  return {
    mailer,
    host,
    port: numOrNull(port),
    encryption,
    auth: authType === null ? null : authType.toLowerCase() !== "none",
    fromEmail,
    fromName,
  };
}

/** Find the first active plugin whose slug is in `slugs`, lowercased-matched. */
async function detectActivePlugin(ctx: PanelProbeContext, slugs: readonly string[]): Promise<string | null> {
  const stdout = await ctx
    .exec(`wp --allow-root plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");
  const active = activePluginSlugs(stdout);
  return slugs.find((slug) => active.has(slug)) ?? null;
}

/** Read the third-party SMTP plugin posture (fallback + conflict signal). */
async function fetchPluginPosture(ctx: PanelProbeContext): Promise<EmailPluginPosture> {
  const plugin = await detectActivePlugin(ctx, SMTP_PLUGIN_SLUGS);
  const posture =
    plugin === WP_MAIL_SMTP_SLUG
      ? await readWpMailSmtp(ctx)
      : plugin === POST_SMTP_SLUG
        ? await readPostSmtp(ctx)
        : null;
  return buildPluginPosture(plugin, posture);
}

/**
 * Read the connector's own email config over the signed channel. Returns the
 * snapshot (+ log tail when unlocked), or null when the site is not a commandable
 * connector link (an un-enrolled/old-connector site degrades to the plugin path
 * rather than erroring the whole panel).
 */
async function fetchConnector(
  ctx: PanelProbeContext,
): Promise<{ connector: EmailConnectorConfig | null; log: EmailLogResponse | null }> {
  if (!ctx.managed) return { connector: null, log: null };
  try {
    const connector = await getEmailConfig(ctx.site);
    // The log read is only meaningful (and only permitted) when unlocked.
    let log: EmailLogResponse | null = null;
    if (!connector.locked) {
      log = await getEmailLog(ctx.site).catch(() => null);
    }
    return { connector, log };
  } catch {
    // Old connector (501), not commandable, or a transient exec failure — fall
    // back to the plugin posture. The panel still renders.
    return { connector: null, log: null };
  }
}

async function fetchEmail(ctx: PanelProbeContext): Promise<EmailData> {
  const [{ connector, log }, plugin] = await Promise.all([fetchConnector(ctx), fetchPluginPosture(ctx)]);
  return mergeEmailData({ connector, plugin, log });
}

export const emailProbe: PanelProbe<EmailData> = {
  id: "email",
  requiresCapability: "email",
  fetch: fetchEmail,
};
