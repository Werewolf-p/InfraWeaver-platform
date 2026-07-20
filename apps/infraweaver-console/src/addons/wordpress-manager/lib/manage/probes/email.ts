/**
 * Email panel probe — SMTP delivery posture read live from the site's mail plugin
 * (gated on the `smtp` capability). WP Mail SMTP and Post SMTP each keep their
 * config in a single option; we read ONLY the non-secret posture fields (mailer,
 * host, port, encryption, auth, from-address) and normalise them into one shape.
 * Other SMTP plugins are reported as active without config introspection. There is
 * no per-send delivery log on this read path (WP Mail SMTP Lite records none), so
 * the panel shows posture only and renders no test-send button.
 *
 * Security: these option blobs also hold the SMTP password (`smtp.pass` /
 * `password`). We deliberately `wp option pluck` each posture field individually
 * rather than `option get`-ing the whole option, so the credential is never read
 * into console memory (nor into any log line) in the first place.
 */
import { WP_SAFE } from "../wp-probe";
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

type EmailPosture = Omit<EmailData, "plugin" | "configured">;

const EMPTY_POSTURE: EmailPosture = {
  mailer: null,
  host: null,
  port: null,
  encryption: null,
  auth: null,
  fromEmail: null,
  fromName: null,
};

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

/** Assemble EmailData from the detected plugin and its (secret-free) posture. */
export function buildEmailData(plugin: string | null, posture: EmailPosture | null): EmailData {
  const base: EmailData = { plugin, ...EMPTY_POSTURE, configured: false };
  if (!posture) return base;
  // "configured" = the detected plugin's config was actually readable, i.e. at
  // least one posture field came back (an all-null read is an empty/absent option).
  const configured = Object.values(posture).some((v) => v !== null);
  return { ...base, ...posture, configured };
}

/** Find the first active plugin whose slug is in `slugs`, lowercased-matched. */
async function detectActivePlugin(ctx: PanelProbeContext, slugs: readonly string[]): Promise<string | null> {
  const stdout = await ctx
    .exec(`wp --allow-root plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");
  let names: string[] = [];
  try {
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (Array.isArray(parsed)) {
      names = parsed
        // `--field=name --format=json` yields a scalar array, but tolerate the
        // object shape (`[{ name }]`) too so a WP-CLI format change can't blind us.
        .map((row) => (typeof row === "string" ? row : typeof (row as { name?: unknown })?.name === "string" ? (row as { name: string }).name : null))
        .filter((n): n is string => Boolean(n))
        .map((n) => n.toLowerCase());
    }
  } catch {
    names = [];
  }
  const active = new Set(names);
  return slugs.find((slug) => active.has(slug)) ?? null;
}

async function fetchEmail(ctx: PanelProbeContext): Promise<EmailData> {
  const plugin = await detectActivePlugin(ctx, SMTP_PLUGIN_SLUGS);

  // Pluck only the non-secret posture fields for the detected plugin; others get a
  // posture-less report. The SMTP password is never read into console memory.
  const posture =
    plugin === WP_MAIL_SMTP_SLUG
      ? await readWpMailSmtp(ctx)
      : plugin === POST_SMTP_SLUG
        ? await readPostSmtp(ctx)
        : null;

  return buildEmailData(plugin, posture);
}

export const emailProbe: PanelProbe<EmailData> = {
  id: "email",
  requiresCapability: "smtp",
  fetch: fetchEmail,
};
