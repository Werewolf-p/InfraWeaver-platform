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
import type Mail from "nodemailer/lib/mailer";
import { brandedEmailHtml, ctaButton, escapeHtml, logoAttachment } from "@/lib/email-logo";

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
export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Mail.Attachment[];
}): Promise<void> {
  const config = resolveSmtpConfig();
  if (!config) throw new Error("SMTP is not configured (SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD)");

  const transport = getTransport(config);

  await transport.sendMail({
    from: config.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
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
  const safeUrl = escapeHtml(enrollmentUrl);
  const inner = [
    `<h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-.3px;color:#0f172a">You're invited to InfraWeaver</h1>`,
    `<p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:#475569">You've been granted access to InfraWeaver. Set up your account to sign in to your apps and storage — it only takes a minute.</p>`,
    `<div style="margin:0 0 26px 0">${ctaButton(enrollmentUrl, "Set up your account")}</div>`,
    `<p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:#64748b">Or paste this link into your browser:</p>`,
    `<p style="margin:0 0 22px 0;word-break:break-all"><a href="${safeUrl}" style="font-size:13px;color:#4f46e5;text-decoration:none">${safeUrl}</a></p>`,
    `<p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8">This link is single-use and will expire. If you did not expect this invitation, you can safely ignore this email.</p>`,
  ].join("");
  const html = brandedEmailHtml(inner, { preview: "Set up your InfraWeaver account to access your apps and storage." });
  await sendMail({ to, subject, text, html, attachments: [logoAttachment()] });
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
  const safeLabel = escapeHtml(appLabel);
  const safeUser = escapeHtml(username);
  const safePass = escapeHtml(password);
  const safeUrl = escapeHtml(launchUrl);
  const credRow = (label: string, valueHtml: string): string =>
    `<tr><td style="padding:11px 14px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#64748b;border-bottom:1px solid #eef1f6;white-space:nowrap;vertical-align:middle">${label}</td>` +
    `<td style="padding:11px 14px;font-size:14px;color:#0f172a;border-bottom:1px solid #eef1f6;vertical-align:middle;word-break:break-all">${valueHtml}</td></tr>`;
  const inner = [
    `<h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-.3px;color:#0f172a">Your ${safeLabel} sign-in is ready</h1>`,
    `<p style="margin:0 0 22px 0;font-size:15px;line-height:1.65;color:#475569">An account has been created for you on <strong>${safeLabel}</strong>. Use these credentials to sign in:</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;border:1px solid #e6e8ef;border-radius:12px;overflow:hidden;margin:0 0 22px 0">`,
    credRow("Username", `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:#0f172a">${safeUser}</code>`),
    credRow("Password", `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:#0f172a;background-color:#f1f5f9;padding:3px 8px;border-radius:6px">${safePass}</code>`),
    // Last row: no bottom border.
    `<tr><td style="padding:11px 14px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#64748b;white-space:nowrap;vertical-align:middle">Sign in</td>` +
      `<td style="padding:11px 14px;font-size:14px;vertical-align:middle;word-break:break-all"><a href="${safeUrl}" style="color:#4f46e5;text-decoration:none">${safeUrl}</a></td></tr>`,
    `</table>`,
    `<div style="margin:0 0 22px 0">${ctaButton(launchUrl, `Open ${safeLabel}`)}</div>`,
    `<p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8">Please change your password after your first sign-in. If you did not expect this, contact your administrator.</p>`,
  ].join("");
  const html = brandedEmailHtml(inner, { preview: `Your ${appLabel} account is ready — sign in with the credentials inside.` });
  await sendMail({ to, subject, text, html, attachments: [logoAttachment()] });
}
