/**
 * Email delivery — the console-side TYPES + zod request validators for the five
 * signed `email.*` commands, plus the merged panel read-model. Isomorphic (no
 * `server-only`): the API route parses write requests through these schemas, the
 * probe narrows connector replies against these types, and the panel component
 * imports the same shapes. Every bound + vocabulary MIRRORS the connector's
 * `IWSL_Email_Delivery` engine and the `email.config.set` / `email.test` wire
 * validators in `class-iwsl-plugin.php`, so the two sides can never drift.
 *
 * SECURITY INVARIANT: the SMTP password is NEVER part of any read shape. It rides
 * the wire exactly once — console → site, write-only, on `email.config.set`. The
 * connector strips it from every reply (`settings_for_render`/`config_snapshot`);
 * this module deliberately has no field that could carry it back to the browser.
 */

import { z } from "zod";

// ── bounds (mirror IWSL_Email_Delivery constants; keep in lockstep) ───────────
/** Per-field char cap the engine enforces (MAX_FIELD_CHARS). */
export const MAX_FIELD_CHARS = 254;
/** Bounded delivery-log ring the connector returns (MAX_LOG). */
export const MAX_LOG = 100;
/** Generous console-side cap on the write-only secret (engine has no hard cap; CRLF is the real gate). */
export const MAX_PASSWORD_CHARS = 1024;

/** Encryption modes the engine accepts (SECURE_MODES); first entry = "none". */
export const SECURE_MODES = ["", "ssl", "tls"] as const;
export type SecureMode = (typeof SECURE_MODES)[number];

/** Where the effective password comes from (settings_for_render → password_source). */
export type PasswordSource = "constant" | "option" | "none";

/** Which delivery path the merged panel is describing. */
export type EmailDeliverySource = "connector" | "plugin" | "none";

/** A delivery-log row's outcome. */
export type EmailLogStatus = "sent" | "failed";

/** The entitlement gate descriptor the connector returns for a locked feature. */
export interface EmailGate {
  readonly unlocked?: boolean;
  readonly reason?: string;
  readonly reasons?: readonly string[];
  readonly tier?: string;
  readonly [key: string]: unknown;
}

/** The stripped SMTP settings (NEVER a password) — the eight engine-owned fields. */
export interface EmailSettings {
  readonly host: string;
  readonly port: number;
  readonly auth: boolean;
  readonly username: string;
  readonly from_email: string;
  readonly from_name: string;
  readonly secure: SecureMode;
  readonly allow_option_password: boolean;
}

/** `email.config.get` result (+ `switch_on`, injected by the plugin runner). */
export interface EmailConnectorConfig {
  readonly gate: EmailGate;
  readonly locked: boolean;
  /** Present only when unlocked — the stripped settings (no password field exists). */
  readonly settings?: EmailSettings;
  /** True when a usable secret exists (constant OR opted-in encrypted option). */
  readonly has_password?: boolean;
  /** constant | option | none — the origin of the effective secret. */
  readonly password_source?: PasswordSource;
  /** True when host + a valid port are set (mail can be routed). */
  readonly configured?: boolean;
  /** The transport ids the engine can configure (e.g. `smtp`). */
  readonly transports?: readonly string[];
  /** Operator kill-switch state for `email_delivery`; false ⇒ hooks unregistered. */
  readonly switch_on?: boolean;
}

/** One bounded, whitelisted, redacted delivery-log entry (only `to`+`subject` ever stored). */
export interface EmailLogEntry {
  readonly time: number;
  readonly to: readonly string[];
  readonly subject: string;
  readonly status: EmailLogStatus;
  /** Redacted failure reason — present on `failed` rows only. */
  readonly error?: string;
}

/** `email.log.get` result — bounded (≤ MAX_LOG), gate-aware. */
export interface EmailLogResponse {
  readonly entries: readonly EmailLogEntry[];
  readonly count: number;
  readonly locked?: boolean;
  readonly gate?: EmailGate;
}

/** `email.test` result — honest about the switch (false ⇒ a real send would fall back to PHP mail()). */
export interface EmailTestResult {
  readonly sent: boolean;
  readonly reason?: string;
  readonly switch_on?: boolean;
  readonly locked?: boolean;
  readonly gate?: EmailGate;
  /** Seconds until the connector-side rate limit clears (present on `rate-limited`). */
  readonly retry_after_s?: number;
}

/** `email.config.set` result — echoes the STRIPPED settings, never the secret. */
export interface EmailConfigSetResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly settings?: EmailSettings;
  readonly locked?: boolean;
  readonly gate?: EmailGate;
}

/** `email.log.clear` result. */
export interface EmailLogClearResult {
  readonly ok: boolean;
  readonly cleared: boolean;
  readonly reason?: string;
  readonly locked?: boolean;
  readonly gate?: EmailGate;
}

/**
 * Third-party SMTP plugin posture (the existing pluck-probe read model). Kept as
 * the fallback for unentitled sites AND for conflict detection when a plugin is
 * active alongside connector delivery. Never carries a secret (posture only).
 */
export interface EmailPluginPosture {
  readonly plugin: string | null;
  readonly mailer: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly encryption: string | null;
  readonly auth: boolean | null;
  readonly fromEmail: string | null;
  readonly fromName: string | null;
  readonly configured: boolean;
}

/**
 * The merged Email panel read-model: one shape that answers "how does this site
 * send mail?" — the connector's own SMTP when available, a third-party plugin's
 * posture as fallback, and a `conflict` flag when both are fighting over
 * `phpmailer_init`.
 */
export interface EmailData {
  /** The delivery path the panel leads with. */
  readonly source: EmailDeliverySource;
  /** True when a managed, commandable connector link answered `email.config.get`. */
  readonly connectorAvailable: boolean;
  /** The connector's own config snapshot (present ⇒ connectorAvailable). */
  readonly connector: EmailConnectorConfig | null;
  /** Third-party plugin posture, when an SMTP plugin is active. */
  readonly plugin: EmailPluginPosture | null;
  /** Recent send/fail history from the connector (unlocked sites only). */
  readonly log: EmailLogResponse | null;
  /** True when connector delivery AND a third-party SMTP plugin are both active. */
  readonly conflict: boolean;
}

/** The non-secret posture fields the probe plucks (everything but `plugin`/`configured`). */
export type EmailPluginPostureFields = Omit<EmailPluginPosture, "plugin" | "configured">;

const EMPTY_POSTURE: EmailPluginPostureFields = {
  mailer: null,
  host: null,
  port: null,
  encryption: null,
  auth: null,
  fromEmail: null,
  fromName: null,
};

/**
 * Assemble an `EmailPluginPosture` from a detected plugin slug and its (secret-free)
 * posture. `configured` = the plugin's config was actually readable, i.e. at least
 * one posture field came back (an all-null read is an empty/absent option). Pure +
 * isomorphic so it is testable without exec — and it carries NO credential field.
 */
export function buildPluginPosture(
  plugin: string | null,
  posture: EmailPluginPostureFields | null,
): EmailPluginPosture {
  const base: EmailPluginPosture = { plugin, ...EMPTY_POSTURE, configured: false };
  if (!posture) return base;
  const configured = Object.values(posture).some((v) => v !== null);
  return { ...base, ...posture, configured };
}

// ── request validators (parity with the plugin's wire validators) ─────────────

/** A single-line string (CRLF rejected — header-injection defence, mirrored pre-engine). */
const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\r\n]/.test(v), "must be a single line");

/**
 * `email.config.set` `settings` — EXACTLY the eight engine fields with the right
 * types (mirrors the `$email_config_set_params` closure). The engine's
 * `save_settings()` remains the authoritative validator (host/port/from format,
 * opt-in, AES-256-GCM fail-closed); this only rejects a malformed wire shape.
 */
export const emailSettingsSchema = z
  .object({
    host: singleLine(MAX_FIELD_CHARS),
    port: z.number().int().min(1).max(65535),
    auth: z.boolean(),
    username: singleLine(MAX_FIELD_CHARS),
    from_email: singleLine(MAX_FIELD_CHARS),
    from_name: singleLine(MAX_FIELD_CHARS),
    secure: z.enum(SECURE_MODES),
    allow_option_password: z.boolean(),
  })
  .strict();

/**
 * `email.config.set` params — `{ settings, password?, clear_password? }`, strays
 * refused. `password` is WRITE-ONLY (single-line; never echoed back). The result
 * type has no password field, so a secret can never round-trip.
 */
export const emailConfigSetParamsSchema = z
  .object({
    settings: emailSettingsSchema,
    password: singleLine(MAX_PASSWORD_CHARS).optional(),
    clear_password: z.boolean().optional(),
  })
  .strict();

export type EmailConfigSetParams = z.infer<typeof emailConfigSetParamsSchema>;

/** `email.test` params — EXACTLY `{ to: <non-empty single-line string> }`. */
export const emailTestParamsSchema = z
  .object({
    to: singleLine(MAX_FIELD_CHARS).refine((v) => v.trim().length > 0, "recipient required"),
  })
  .strict();

export type EmailTestParams = z.infer<typeof emailTestParamsSchema>;

/** The write verbs the dedicated email route dispatches (one signed method per verb). */
export const EMAIL_WRITE_VERBS = ["config", "test", "clear-log"] as const;
export type EmailWriteVerb = (typeof EMAIL_WRITE_VERBS)[number];

// ── merge logic (pure — unit-tested without exec/DNS) ─────────────────────────

/** True when the connector is actively delivering mail (entitled, switched on, configured). */
export function connectorDelivering(connector: EmailConnectorConfig | null): boolean {
  return (
    connector !== null &&
    !connector.locked &&
    connector.switch_on === true &&
    connector.configured === true
  );
}

/**
 * Merge the connector snapshot and the third-party plugin posture into the one
 * panel read-model. `source` leads with the connector whenever it is available
 * (even locked — "locked" is a renderable upgrade state); falls back to a plugin;
 * else "none". `conflict` is true only when the connector is actually delivering
 * AND a third-party SMTP plugin is also active (both hook `phpmailer_init`).
 */
export function mergeEmailData(input: {
  readonly connector: EmailConnectorConfig | null;
  readonly plugin: EmailPluginPosture | null;
  readonly log: EmailLogResponse | null;
}): EmailData {
  const connectorAvailable = input.connector !== null;
  const pluginActive = input.plugin !== null && input.plugin.plugin !== null;

  const source: EmailDeliverySource = connectorAvailable
    ? "connector"
    : pluginActive
      ? "plugin"
      : "none";

  const conflict = connectorDelivering(input.connector) && pluginActive;

  return {
    source,
    connectorAvailable,
    connector: input.connector,
    plugin: input.plugin,
    log: input.log,
    conflict,
  };
}

/**
 * Map a connector engine `reason` code (from save_settings/send_test) to a
 * human, actionable message. Pure so the panel and tests share one vocabulary.
 * Unknown codes fall through to a generic message rather than leaking the raw code.
 */
export function emailReasonText(reason: string): string {
  switch (reason) {
    case "":
      return "";
    case "entitlement-locked":
      return "Email delivery isn't included in this site's plan.";
    case "delivery-switch-off":
      return "Email delivery is switched off, so a real send would fall back to PHP mail(). Turn the switch on to route through SMTP.";
    case "password-storage-not-allowed":
      return "Turn on “Store password in the database” to save a password here, or set the IWSL_SMTP_PASS constant in wp-config.php.";
    case "password-encryption-unavailable":
      return "This site can't encrypt the password securely (missing cipher or salts). Set the IWSL_SMTP_PASS constant in wp-config.php instead.";
    case "bad-host":
      return "The SMTP host isn't a valid hostname.";
    case "bad-port":
      return "The SMTP port must be between 1 and 65535.";
    case "bad-secure":
      return "The encryption mode must be none, SSL or TLS.";
    case "bad-username":
      return "The username can't contain line breaks.";
    case "bad-password":
      return "The password can't contain line breaks.";
    case "bad-from-email":
      return "The From address isn't a valid email address.";
    case "bad-from-name":
      return "The From name can't contain line breaks.";
    case "invalid-recipient":
      return "Enter a valid recipient address for the test send.";
    case "rate-limited":
      return "A test was just sent — wait a moment before trying again.";
    case "send-failed":
      return "The test send failed. Check the host, port, credentials, and that SMTP AUTH is enabled for the mailbox.";
    default:
      return "The request couldn't be completed.";
  }
}
