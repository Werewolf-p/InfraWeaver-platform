/**
 * Email panel probe — SMTP delivery posture read live from the site's mail plugin
 * (gated on the `smtp` capability). WP Mail SMTP and Post SMTP each keep their
 * config in a single option we read and normalise into one posture shape (mailer,
 * host, port, encryption, auth, from-address). Other SMTP plugins are reported as
 * active without config introspection. There is no per-send delivery log on this
 * read path (WP Mail SMTP Lite records none), so the panel shows posture only and
 * renders no test-send button.
 */
import { WP_SAFE, parseJsonArray, parseJsonObject, fieldStr, fieldNum } from "../wp-probe";
import { SMTP_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Slugs whose single-option config we can decode. */
const WP_MAIL_SMTP_SLUG = "wp-mail-smtp";
const POST_SMTP_SLUG = "post-smtp";

export interface EmailData {
  /** Active SMTP plugin slug (from SMTP_PLUGIN_SLUGS), or null. */
  readonly plugin: string | null;
  /** Transport/mailer type (e.g. "smtp", "sendmail", "mailgun"), or null. */
  readonly mailer: string | null;
  readonly host: string | null;
  readonly port: number | null;
  /** "none" | "ssl" | "tls" (raw from the plugin), or null. */
  readonly encryption: string | null;
  /** Whether SMTP authentication is enabled, or null when unknown. */
  readonly auth: boolean | null;
  readonly fromEmail: string | null;
  readonly fromName: string | null;
  /** True when the detected plugin's config was readable. */
  readonly configured: boolean;
}

/** Nested WP Mail SMTP option group. */
type SmtpRow = Record<string, unknown>;

/** Narrow an unknown nested value to a plain object, or null. */
function toRow(value: unknown): SmtpRow | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as SmtpRow) : null;
}

/** Read a boolean-ish flag stored as bool, "1"/"0", "true"/"false" or number. */
function readBool(row: SmtpRow, key: string): boolean | null {
  const v = row[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "1" || t === "true" || t === "yes") return true;
    if (t === "0" || t === "false" || t === "no" || t === "") return false;
  }
  return null;
}

type EmailPosture = Omit<EmailData, "plugin" | "configured">;

/** Decode WP Mail SMTP's `wp_mail_smtp` option (`{ mail: {...}, smtp: {...} }`). */
function parseWpMailSmtp(stdout: string): EmailPosture | null {
  const obj = parseJsonObject<Record<string, unknown>>(stdout);
  if (!obj) return null;
  const mail = toRow(obj.mail);
  const smtp = toRow(obj.smtp);
  return {
    mailer: mail ? fieldStr(mail, "mailer") : null,
    host: smtp ? fieldStr(smtp, "host") : null,
    port: smtp ? fieldNum(smtp, "port") : null,
    encryption: smtp ? fieldStr(smtp, "encryption") : null,
    auth: smtp ? readBool(smtp, "auth") : null,
    fromEmail: mail ? fieldStr(mail, "from_email") : null,
    fromName: mail ? fieldStr(mail, "from_name") : null,
  };
}

/** Decode Post SMTP's flat `postman_options` option. */
function parsePostSmtp(stdout: string): EmailPosture | null {
  const obj = parseJsonObject<Record<string, unknown>>(stdout);
  if (!obj) return null;
  const authType = fieldStr(obj, "auth_type");
  return {
    mailer: fieldStr(obj, "transport_type"),
    host: fieldStr(obj, "hostname"),
    port: fieldNum(obj, "port"),
    encryption: fieldStr(obj, "enc_type"),
    auth: authType !== null ? authType.toLowerCase() !== "none" : null,
    fromEmail: fieldStr(obj, "sender_email"),
    fromName: fieldStr(obj, "sender_name"),
  };
}

export function parseEmail(input: { plugin: string | null; wpMailSmtp: string; postSmtp: string }): EmailData {
  const base: EmailData = {
    plugin: input.plugin,
    mailer: null,
    host: null,
    port: null,
    encryption: null,
    auth: null,
    fromEmail: null,
    fromName: null,
    configured: false,
  };

  const posture =
    input.plugin === WP_MAIL_SMTP_SLUG
      ? parseWpMailSmtp(input.wpMailSmtp)
      : input.plugin === POST_SMTP_SLUG
        ? parsePostSmtp(input.postSmtp)
        : null;

  return posture ? { ...base, ...posture, configured: true } : base;
}

/** Find the first active plugin whose slug is in `slugs`, lowercased-matched. */
async function detectActivePlugin(ctx: PanelProbeContext, slugs: readonly string[]): Promise<string | null> {
  const stdout = await ctx
    .exec(`wp --allow-root plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");
  const active = new Set(
    parseJsonArray<{ name?: string }>(stdout)
      .map((row) => fieldStr(row, "name")?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  return slugs.find((slug) => active.has(slug)) ?? null;
}

async function fetchEmail(ctx: PanelProbeContext): Promise<EmailData> {
  const plugin = await detectActivePlugin(ctx, SMTP_PLUGIN_SLUGS);

  // Read only the option for the detected plugin; others get a posture-less report.
  const wpMailSmtp =
    plugin === WP_MAIL_SMTP_SLUG
      ? await ctx.exec(`${WP_SAFE} option get wp_mail_smtp --format=json`).then((r) => r.stdout).catch(() => "")
      : "";
  const postSmtp =
    plugin === POST_SMTP_SLUG
      ? await ctx.exec(`${WP_SAFE} option get postman_options --format=json`).then((r) => r.stdout).catch(() => "")
      : "";

  return parseEmail({ plugin, wpMailSmtp, postSmtp });
}

export const emailProbe: PanelProbe<EmailData> = {
  id: "email",
  requiresCapability: "smtp",
  fetch: fetchEmail,
};
