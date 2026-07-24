/**
 * SMTP provider presets + deliverability guidance — pure, isomorphic, and
 * unit-testable without any network. The connector treats Office 365 / Google
 * Workspace as GENERIC SMTP submission (the only provider knowledge lives in
 * `configure_mailer()`'s From-forcing), so a "provider" here is just a set of
 * sensible defaults plus the SPF/DKIM/DMARC facts an operator needs to land mail.
 *
 * `applyPreset` returns a NEW settings object (immutable) — the console form
 * pre-fills from it, then the operator can override any field before saving. It
 * never touches the write-only password.
 */

import type { EmailSettings, SecureMode } from "./email";

export type EmailPresetId = "office365" | "google" | "custom";

export interface EmailPreset {
  readonly id: EmailPresetId;
  readonly label: string;
  /** Pre-filled host, or null to leave the field open (custom). */
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: SecureMode | null;
  /** Whether SMTP AUTH is on by default for this provider. */
  readonly auth: boolean;
  /**
   * Strict providers (O365/Gmail) reject WordPress's default `wordpress@<domain>`
   * (5.7.57) — the From must be an address the authenticated mailbox may send as.
   */
  readonly fromMustMatchAuth: boolean;
  /** The SPF `include:` mechanism this provider requires, or null. */
  readonly spfInclude: string | null;
  /** Provider DKIM/selector setup docs, or null. */
  readonly dkimDocsUrl: string | null;
  /** One-line operator note. */
  readonly note: string;
}

export const OFFICE365_PRESET: EmailPreset = {
  id: "office365",
  label: "Office 365",
  host: "smtp.office365.com",
  port: 587,
  secure: "tls",
  auth: true,
  fromMustMatchAuth: true,
  spfInclude: "spf.protection.outlook.com",
  dkimDocsUrl: "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure",
  note: "From must be a mailbox the account may send as, and SMTP AUTH must be enabled for it (some tenants disable it).",
};

export const GOOGLE_PRESET: EmailPreset = {
  id: "google",
  label: "Google Workspace",
  host: "smtp.gmail.com",
  port: 587,
  secure: "tls",
  auth: true,
  fromMustMatchAuth: true,
  spfInclude: "_spf.google.com",
  dkimDocsUrl: "https://support.google.com/a/answer/174124",
  note: "Use an app password (or SMTP relay) and a From the mailbox is allowed to send as.",
};

export const CUSTOM_PRESET: EmailPreset = {
  id: "custom",
  label: "Custom SMTP",
  host: null,
  port: null,
  secure: null,
  auth: true,
  fromMustMatchAuth: false,
  spfInclude: null,
  dkimDocsUrl: null,
  note: "Enter your provider's SMTP host, port and encryption.",
};

export const EMAIL_PRESETS: readonly EmailPreset[] = [OFFICE365_PRESET, GOOGLE_PRESET, CUSTOM_PRESET];

/** Look a preset up by id, or `undefined`. */
export function findPreset(id: string): EmailPreset | undefined {
  return EMAIL_PRESETS.find((p) => p.id === id);
}

/**
 * Return a NEW settings object with the preset's defaults applied over `base`.
 * Only fields the preset actually pins (non-null) are changed; `custom` leaves
 * host/port/secure untouched. Never mutates `base` and never touches secrets.
 */
export function applyPreset(preset: EmailPreset, base: EmailSettings): EmailSettings {
  return {
    ...base,
    host: preset.host ?? base.host,
    port: preset.port ?? base.port,
    secure: preset.secure ?? base.secure,
    auth: preset.auth,
  };
}

/**
 * Best-effort match of stored settings back to a preset (so the form re-opens on
 * the right provider). Falls back to "custom" when nothing matches.
 */
export function detectPreset(settings: Pick<EmailSettings, "host">): EmailPresetId {
  const host = settings.host.trim().toLowerCase();
  if (host === OFFICE365_PRESET.host) return "office365";
  if (host === GOOGLE_PRESET.host) return "google";
  return "custom";
}

/**
 * A deliverability warning when the From won't be accepted by a strict provider:
 * when the preset forces From = auth mailbox and a non-empty From differs from the
 * username. Empty From is fine (the engine falls back to the username at send).
 */
export function fromIdentityWarning(
  preset: EmailPreset,
  settings: Pick<EmailSettings, "from_email" | "username">,
): string | null {
  if (!preset.fromMustMatchAuth) return null;
  const from = settings.from_email.trim().toLowerCase();
  const user = settings.username.trim().toLowerCase();
  if (from === "" || user === "" || from === user) return null;
  return `${preset.label} requires the From address to be one the authenticated mailbox (${settings.username}) may send as, or mail will be rejected.`;
}
