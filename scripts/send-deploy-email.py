#!/usr/bin/env python3
"""
Send styled HTML deployment summary email with platform credentials.
Expected environment variables:
  SMTP_USERNAME, SMTP_PASSWORD, SMTP_TO,
  DEPLOY_ENV, DEPLOY_RUN_URL,
  BAO_TOKEN, BAO_UNSEAL, NB_PAT, NB_SETUP
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

env        = os.environ.get("DEPLOY_ENV", "unknown")
run_url    = os.environ.get("DEPLOY_RUN_URL", "#")
bao_token  = os.environ.get("BAO_TOKEN", "unavailable")
bao_unseal = os.environ.get("BAO_UNSEAL", "unavailable")
nb_pat     = os.environ.get("NB_PAT", "unavailable")
nb_setup   = os.environ.get("NB_SETUP", "unavailable")
auth_url   = os.environ.get("AUTHENTIK_URL", "https://auth.rlservers.com")
auth_email = os.environ.get("AUTHENTIK_EMAIL", "remonhulst@gmail.com")
auth_pass  = os.environ.get("AUTHENTIK_PASSWORD", "unavailable")
timestamp  = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

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

<!-- Wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header gradient banner -->
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

  <!-- Status bar -->
  <tr>
    <td style="background:#0d1b2a;padding:16px 40px;border-left:1px solid #1e2d45;border-right:1px solid #1e2d45;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="color:#22c55e;font-size:13px;font-weight:600;">
            ✅ &nbsp;DEPLOYMENT SUCCESSFUL
          </td>
          <td align="right" style="color:#4a5568;font-size:12px;">{timestamp}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:8px;">
            <span style="background:#1e2d45;color:#4f8ef7;font-size:12px;padding:4px 10px;
                         border-radius:20px;display:inline-block;">
              environment: <strong style="color:#7eb3ff;">{env}</strong>
            </span>
            &nbsp;
            <a href="{run_url}" style="background:#1e2d45;color:#4f8ef7;font-size:12px;padding:4px 10px;
                                       border-radius:20px;display:inline-block;text-decoration:none;">
              🔗 View Run
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="background:#131929;padding:32px 40px;
               border-left:1px solid #1e2d45;border-right:1px solid #1e2d45;">

      <!-- Section: OpenBao -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0d1b2a;border:1px solid #1e3a5f;border-radius:12px;
                    margin-bottom:24px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(90deg,#0a2540,#0d1b2a);
                     padding:14px 20px;border-bottom:1px solid #1e3a5f;">
            <span style="font-size:18px;">🔐</span>
            <span style="color:#7eb3ff;font-size:14px;font-weight:700;
                         margin-left:8px;text-transform:uppercase;letter-spacing:1px;">
              OpenBao — Vault
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Dashboard URL</p>
            <p style="margin:0 0 16px;color:#e2e8f0;font-size:13px;">
              http://openbao.prod.local
              <span style="color:#4a5568;font-size:11px;margin-left:6px;">(via NetBird VPN)</span>
            </p>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Root Token</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;margin-bottom:16px;font-family:monospace;
                        font-size:13px;color:#4f8ef7;word-break:break-all;">
              {bao_token}
            </div>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Unseal Key</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;font-family:monospace;font-size:13px;
                        color:#4f8ef7;word-break:break-all;">
              {bao_unseal}
            </div>
          </td>
        </tr>
      </table>

      <!-- Section: NetBird -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0d1b2a;border:1px solid #1e3a5f;border-radius:12px;
                    margin-bottom:24px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(90deg,#0a2540,#0d1b2a);
                     padding:14px 20px;border-bottom:1px solid #1e3a5f;">
            <span style="font-size:18px;">🛡️</span>
            <span style="color:#7eb3ff;font-size:14px;font-weight:700;
                         margin-left:8px;text-transform:uppercase;letter-spacing:1px;">
              NetBird VPN
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Management Dashboard</p>
            <p style="margin:0 0 16px;">
              <a href="https://netbird.rlservers.com"
                 style="color:#4f8ef7;font-size:13px;text-decoration:none;">
                https://netbird.rlservers.com ↗
              </a>
            </p>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">PAT Token <span style="color:#22c55e;">(admin access)</span></p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;margin-bottom:16px;font-family:monospace;
                        font-size:13px;color:#4f8ef7;word-break:break-all;">
              {nb_pat}
            </div>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Setup Key <span style="color:#94a3b8;">(connect new peers)</span></p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;margin-bottom:16px;font-family:monospace;
                        font-size:13px;color:#4f8ef7;word-break:break-all;">
              {nb_setup}
            </div>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Connect Command</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;font-family:monospace;font-size:12px;
                        color:#a3e635;word-break:break-all;">
              netbird up --management-url https://netbird.rlservers.com --setup-key {nb_setup}
            </div>
          </td>
        </tr>
      </table>

      <!-- Section: Authentik SSO -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0d1b2a;border:1px solid #1e3a5f;border-radius:12px;
                    margin-bottom:24px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(90deg,#0a2540,#0d1b2a);
                     padding:14px 20px;border-bottom:1px solid #1e3a5f;">
            <span style="font-size:18px;">🔑</span>
            <span style="color:#7eb3ff;font-size:14px;font-weight:700;
                         margin-left:8px;text-transform:uppercase;letter-spacing:1px;">
              Authentik SSO
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Login URL</p>
            <p style="margin:0 0 16px;">
              <a href="{auth_url}"
                 style="color:#4f8ef7;font-size:13px;text-decoration:none;">
                {auth_url} ↗
              </a>
            </p>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Username / Email</p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;margin-bottom:16px;font-family:monospace;
                        font-size:13px;color:#4f8ef7;word-break:break-all;">
              {auth_email}
            </div>

            <p style="margin:0 0 4px;color:#4a5568;font-size:11px;text-transform:uppercase;
                      letter-spacing:1px;">Password <span style="color:#22c55e;">(admin)</span></p>
            <div style="background:#0a1628;border:1px solid #1e3a5f;border-radius:8px;
                        padding:10px 14px;font-family:monospace;font-size:13px;
                        color:#4f8ef7;word-break:break-all;">
              {auth_pass}
            </div>
          </td>
        </tr>
      </table>

      <!-- Section: Services accessible via VPN -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0d1b2a;border:1px solid #1e3a5f;border-radius:12px;
                    margin-bottom:8px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(90deg,#0a2540,#0d1b2a);
                     padding:14px 20px;border-bottom:1px solid #1e3a5f;">
            <span style="font-size:18px;">🌐</span>
            <span style="color:#7eb3ff;font-size:14px;font-weight:700;
                         margin-left:8px;text-transform:uppercase;letter-spacing:1px;">
              Services (after VPN connect)
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:6px 0;border-bottom:1px solid #131929;">
                  <span style="color:#94a3b8;font-size:12px;width:120px;display:inline-block;">ArgoCD</span>
                  <a href="http://argocd.prod.local"
                     style="color:#4f8ef7;font-size:12px;text-decoration:none;">
                    http://argocd.prod.local
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 0;border-bottom:1px solid #131929;">
                  <span style="color:#94a3b8;font-size:12px;width:120px;display:inline-block;">Grafana</span>
                  <a href="http://grafana.prod.local"
                     style="color:#4f8ef7;font-size:12px;text-decoration:none;">
                    http://grafana.prod.local
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 0;border-bottom:1px solid #131929;">
                  <span style="color:#94a3b8;font-size:12px;width:120px;display:inline-block;">OpenBao UI</span>
                  <a href="http://openbao.prod.local"
                     style="color:#4f8ef7;font-size:12px;text-decoration:none;">
                    http://openbao.prod.local
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 0;">
                  <span style="color:#94a3b8;font-size:12px;width:120px;display:inline-block;">Longhorn</span>
                  <a href="http://longhorn.prod.local"
                     style="color:#4f8ef7;font-size:12px;text-decoration:none;">
                    http://longhorn.prod.local
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:12px 0 0;color:#4a5568;font-size:11px;">
              💡 All credentials for above services are stored in OpenBao at
              <code style="color:#7eb3ff;">secret/platform/*</code>
            </p>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#0a0f1a;padding:20px 40px;border-radius:0 0 16px 16px;
               border:1px solid #1e2d45;border-top:1px solid #1e3a5f;text-align:center;">
      <p style="margin:0;color:#2d3748;font-size:11px;">
        InfraWeaver Platform &nbsp;·&nbsp; All credentials are randomly generated per deployment
        &nbsp;·&nbsp; Keep this email secure
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

OPENBAO (VAULT)
  UI         : http://openbao.prod.local (via NetBird VPN)
  Root Token : {bao_token}
  Unseal Key : {bao_unseal}

NETBIRD VPN
  Dashboard  : https://netbird.rlservers.com
  PAT Token  : {nb_pat}
  Setup Key  : {nb_setup}
  Connect    : netbird up --management-url https://netbird.rlservers.com --setup-key {nb_setup}

AUTHENTIK SSO
  Login URL  : {auth_url}
  Email      : {auth_email}
  Password   : {auth_pass}

SERVICES (accessible after VPN connect)
  ArgoCD     : http://argocd.prod.local
  Grafana    : http://grafana.prod.local
  Longhorn   : http://longhorn.prod.local
  OpenBao UI : http://openbao.prod.local

All service credentials are stored in OpenBao at secret/platform/*
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
