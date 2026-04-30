#!/usr/bin/env python3
"""
Send styled HTML deployment summary email with platform credentials.
Expected environment variables:
  SMTP_USERNAME, SMTP_PASSWORD, SMTP_TO,
  DEPLOY_ENV, DEPLOY_RUN_URL,
  BAO_TOKEN, BAO_UNSEAL
"""
import smtplib, ssl, os, sys
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

smtp_host  = "smtp-mail.outlook.com"
smtp_port  = 587
smtp_user  = os.environ["SMTP_USERNAME"]
smtp_pass  = os.environ["SMTP_PASSWORD"]
smtp_to    = os.environ["SMTP_TO"]

env           = os.environ.get("DEPLOY_ENV", "unknown")
run_url       = os.environ.get("DEPLOY_RUN_URL", "#")
bao_token     = os.environ.get("BAO_TOKEN", "unavailable")
bao_unseal    = os.environ.get("BAO_UNSEAL", "unavailable")
homepage_url  = "https://home.rlservers.com"
timestamp     = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

subject = f"🚀 InfraWeaver | {env} deployment complete"

html = f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>InfraWeaver Deployment</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <tr>
    <td style="background:linear-gradient(135deg,#1a1f2e 0%,#0d1b2a 40%,#0a2540 100%);
               border-radius:16px 16px 0 0;padding:40px 40px 32px;text-align:center;
               border-top:3px solid #4f8ef7;">
      <div style="font-size:36px;margin-bottom:8px;">⚡</div>
      <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
        InfraWeaver
      </h1>
      <p style="margin:6px 0 0;font-size:13px;color:#6b7fa3;text-transform:uppercase;letter-spacing:2px;">
        Platform Deployment
      </p>
    </td>
  </tr>

  <tr>
    <td style="background:#0d1b2a;padding:16px 40px;border-left:1px solid #1e2d45;border-right:1px solid #1e2d45;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="color:#22c55e;font-size:13px;font-weight:600;">✅ &nbsp;DEPLOYMENT SUCCESSFUL</td>
          <td align="right" style="color:#4a5568;font-size:12px;">{timestamp}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:8px;">
            <span style="background:#1e2d45;color:#4f8ef7;font-size:12px;padding:4px 10px;border-radius:20px;display:inline-block;">
              environment: <strong style="color:#7eb3ff;">{env}</strong>
            </span>
            &nbsp;
            <a href="{run_url}" style="background:#1e2d45;color:#4f8ef7;font-size:12px;padding:4px 10px;border-radius:20px;display:inline-block;text-decoration:none;">
              🔗 View Run
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td style="background:#131929;padding:32px 40px;border-left:1px solid #1e2d45;border-right:1px solid #1e2d45;">

      <!-- Homepage Dashboard Banner -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:linear-gradient(135deg,#0a2540,#0d3060);border:1px solid #2563eb;
                    border-radius:12px;margin-bottom:24px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px;text-align:center;">
            <div style="font-size:32px;margin-bottom:8px;">🏠</div>
            <h2 style="margin:0 0 6px;color:#ffffff;font-size:18px;font-weight:700;">Homelab Dashboard</h2>
            <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">All your services in one place — with live health status</p>
            <p style="margin:0 0 16px;color:#f59e0b;font-size:12px;">🔒 Requires NetBird VPN — connect first</p>
            <a href="{homepage_url}"
               style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:700;
                      padding:12px 28px;border-radius:8px;text-decoration:none;letter-spacing:0.5px;">
              Open Dashboard → {homepage_url}
            </a>
          </td>
        </tr>
      </table>

      <!-- OpenBao -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0d1b2a;border:1px solid #1e3a5f;border-radius:12px;
                    margin-bottom:8px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(90deg,#0a2540,#0d1b2a);padding:14px 20px;border-bottom:1px solid #1e3a5f;">
            <span style="font-size:18px;">🔐</span>
            <span style="color:#7eb3ff;font-size:14px;font-weight:700;margin-left:8px;text-transform:uppercase;letter-spacing:1px;">
              OpenBao — Vault
            </span>
            <span style="color:#4a5568;font-size:11px;margin-left:8px;">(all other credentials are stored here)</span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Dashboard URL</p>
            <p style="margin:0 0 16px;">
              <a href="https://openbao.int.rlservers.com" style="color:#4f8ef7;font-size:13px;text-decoration:none;">
                https://openbao.int.rlservers.com ↗
              </a>
              <span style="color:#4a5568;font-size:11px;margin-left:6px;">(via NetBird VPN)</span>
            </p>
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Root Token</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;padding:10px 14px;
                        margin-bottom:16px;font-family:monospace;font-size:13px;color:#4f8ef7;word-break:break-all;">
              {bao_token}
            </div>
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Unseal Key</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;padding:10px 14px;
                        font-family:monospace;font-size:13px;color:#4f8ef7;word-break:break-all;">
              {bao_unseal}
            </div>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <tr>
    <td style="background:#0a0f1a;padding:20px 40px;border-radius:0 0 16px 16px;
               border:1px solid #1e2d45;border-top:1px solid #1e3a5f;text-align:center;">
      <p style="margin:0;color:#2d3748;font-size:11px;">
        InfraWeaver Platform &nbsp;·&nbsp; All credentials are randomly generated per deployment &nbsp;·&nbsp; Keep this email secure
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>
"""

plain = f"""\
InfraWeaver Platform — Deployment Complete
==========================================
Environment : {env}
Timestamp   : {timestamp}
Run         : {run_url}

HOME DASHBOARD (requires NetBird VPN)
  {homepage_url}
  All services with live health status — connect to VPN first.

OPENBAO VAULT — all other credentials are stored here
  Dashboard  : https://openbao.int.rlservers.com  (via NetBird VPN)
  Root Token : {bao_token}
  Unseal Key : {bao_unseal}
"""

msg = MIMEMultipart("alternative")
msg["Subject"] = subject
msg["From"]    = smtp_user
msg["To"]      = smtp_to
msg.attach(MIMEText(plain, "plain"))
msg.attach(MIMEText(html, "html"))

ctx = ssl.create_default_context()
try:
    with smtplib.SMTP(smtp_host, smtp_port) as s:
        s.ehlo()
        s.starttls(context=ctx)
        s.login(smtp_user, smtp_pass)
        s.sendmail(smtp_user, smtp_to, msg.as_string())
    print(f"✅ Deployment summary email sent to {smtp_to}")
except Exception as e:
    print(f"❌ Failed to send email: {e}", file=sys.stderr)
    sys.exit(1)
