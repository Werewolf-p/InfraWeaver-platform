/**
 * First-party SMTP sender — SERVER ONLY.
 *
 * Until now the console had no mail transport: Authentik sent its own templated
 * recovery/invite mail via `secret/platform/authentik` SMTP creds, but there was no
 * path to send an arbitrary body (an invitation link, a provisioned credential). This
 * is that path — a thin wrapper over nodemailer, configured from env so no secret is
 * ever hardcoded.
 *
 * From-address rule (do NOT relax): Office365 submission (smtp-mail.outlook.com) auths
 * as a single mailbox (`SMTP_USERNAME`) and rejects a From that differs from it with
 * `550 5.7.60 "not allowed to send as this sender"` unless SendAs is granted to the
 * From address. `SMTP_FROM` therefore defaults to the authenticated mailbox and should
 * only be set to another address (e.g. noreply@…) once that address has SendAs on O365.
 * A `${…}`-looking value (an unrendered manifest placeholder) is treated as unset so a
 * misconfigured overlay can never send as a literal placeholder.
 */
import "server-only";
import nodemailer from "nodemailer";

/** SMTP transport config, read from env at send time. Nothing here is secret at rest —
 *  the username/password come from the ESO-projected `infraweaver-console-secret`. */
interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** True when a manifest placeholder (`${BASE_DOMAIN}`) reached us unrendered. */
function isUnrendered(value: string): boolean {
  return value.includes("${");
}

/**
 * Resolve SMTP config from env, or null when it is not fully configured. Returning
 * null (rather than throwing) lets the caller degrade gracefully — an invite still
 * mints and returns its link even when mail is not wired up.
 */
export function resolveSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST || "").trim();
  const user = (process.env.SMTP_USERNAME || "").trim();
  const pass = process.env.SMTP_PASSWORD || "";
  const port = Number(process.env.SMTP_PORT) || 587;
  if (!host || !user || !pass) return null;

  // From MUST be the authenticated mailbox unless SendAs is granted (O365 550 5.7.60).
  // An explicit SMTP_FROM overrides, but a blank or unrendered value falls back to it.
  const configuredFrom = (process.env.SMTP_FROM || "").trim();
  const from = configuredFrom && !isUnrendered(configuredFrom) ? configuredFrom : user;
  return { host, port, user, pass, from };
}

/** True when the console has enough SMTP config to attempt a send. */
export function isMailerConfigured(): boolean {
  return resolveSmtpConfig() !== null;
}

// Transport is cached per resolved config (env is static for a pod's lifetime), so
// repeated sends reuse the same nodemailer instance instead of paying a fresh
// TCP+STARTTLS+AUTH setup each time. A config change (new key) rebuilds it.
let cachedTransport: { key: string; transport: nodemailer.Transporter } | null = null;

function getTransport(config: SmtpConfig): nodemailer.Transporter {
  const key = JSON.stringify(config);
  if (cachedTransport?.key === key) return cachedTransport.transport;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 587 is STARTTLS (secure:false + upgrade); 465 is implicit TLS.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },
  });
  cachedTransport = { key, transport };
  return transport;
}

/**
 * Send one email. Throws on any failure (unconfigured, connection, auth, or a 5xx
 * rejection such as O365's 550) — callers that must not fail their whole operation on
 * a bounce catch it and report the delivery as failed instead.
 */
export async function sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  const config = resolveSmtpConfig();
  if (!config) throw new Error("SMTP is not configured (SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD)");

  const transport = getTransport(config);

  await transport.sendMail({
    from: config.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });
}

/**
 * Deliver an Authentik enrollment invitation. The link is the sole payload; the body is
 * a short branded message with a plaintext fallback so any client can act on it.
 */
export async function sendInviteEmail(to: string, enrollmentUrl: string): Promise<void> {
  const subject = "You're invited to InfraWeaver";
  const text = [
    "You have been invited to InfraWeaver.",
    "",
    "Open the link below to set up your account:",
    enrollmentUrl,
    "",
    "This link is single-use and will expire. If you did not expect this invitation, you can ignore this email.",
  ].join("\n");
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">`,
    `<p>You have been invited to <strong>InfraWeaver</strong>.</p>`,
    `<p><a href="${enrollmentUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Set up your account</a></p>`,
    `<p style="font-size:13px;color:#475569">Or paste this link into your browser:<br><a href="${enrollmentUrl}">${enrollmentUrl}</a></p>`,
    `<p style="font-size:12px;color:#94a3b8">This link is single-use and will expire. If you did not expect this invitation, you can ignore this email.</p>`,
    `</div>`,
  ].join("");
  await sendMail({ to, subject, text, html });
}

/**
 * Deliver a freshly-provisioned local app account's credentials. Used for apps that
 * cannot federate via OIDC (Jellyfin), where the user needs a username+password to
 * sign in. The same password is at rest in OpenBao for an in-console reveal; this is
 * the push path that removes the manual hand-off. All fields are console-controlled
 * (username is validated, password is generated from a fixed alphabet), so they are
 * safe to interpolate into the HTML body.
 */
export async function sendCredentialEmail(input: {
  to: string;
  appLabel: string;
  launchUrl: string;
  username: string;
  password: string;
}): Promise<void> {
  const { to, appLabel, launchUrl, username, password } = input;
  const subject = `Your ${appLabel} sign-in`;
  const text = [
    `An account has been created for you on ${appLabel}.`,
    "",
    "Sign in with these credentials:",
    "",
    `  Username: ${username}`,
    `  Password: ${password}`,
    `  Sign in:  ${launchUrl}`,
    "",
    "Please change your password after your first sign-in. If you did not expect this, contact the administrator.",
  ].join("\n");
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">`,
    `<p>An account has been created for you on <strong>${appLabel}</strong>.</p>`,
    `<p>Sign in with these credentials:</p>`,
    `<table style="border-collapse:collapse;font-size:14px">`,
    `<tr><td style="padding:2px 12px 2px 0;color:#475569">Username</td><td><code>${username}</code></td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#475569">Password</td><td><code>${password}</code></td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#475569">Sign in</td><td><a href="${launchUrl}">${launchUrl}</a></td></tr>`,
    `</table>`,
    `<p style="font-size:13px;color:#475569">Please change your password after your first sign-in.</p>`,
    `<p style="font-size:12px;color:#94a3b8">If you did not expect this, contact the administrator.</p>`,
    `</div>`,
  ].join("");
  await sendMail({ to, subject, text, html });
}
