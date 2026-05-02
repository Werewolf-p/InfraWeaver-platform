#!/usr/bin/env python3
"""
InfraWeaver deployment summary email — styled with InfraWeaver Prime dark theme.
Sections: NetBird VPN access → Homelab Dashboard → OpenBao Vault.

Environment variables:
  SMTP_USERNAME, SMTP_PASSWORD, SMTP_TO
  DEPLOY_ENV, DEPLOY_RUN_URL
  BAO_TOKEN, BAO_UNSEAL
  AUTHENTIK_ADMIN_PASS, AUTHENTIK_RECOVERY_LINK
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

env              = os.environ.get("DEPLOY_ENV", "unknown")
run_url          = os.environ.get("DEPLOY_RUN_URL", "#")
bao_token        = os.environ.get("BAO_TOKEN", "unavailable")
bao_unseal       = os.environ.get("BAO_UNSEAL", "unavailable")
auth_admin_pass  = os.environ.get("AUTHENTIK_ADMIN_PASS", "unavailable")
auth_recovery    = os.environ.get("AUTHENTIK_RECOVERY_LINK", "")
timestamp        = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

homepage_url = "https://home.int.rlservers.com"
auth_url     = "https://auth.rlservers.com"
netbird_url  = "https://netbird.rlservers.com"
openbao_url  = "https://openbao.int.rlservers.com"

subject = f"\u26a1 InfraWeaver | {env} deployment complete"

# ── InfraWeaver Prime palette (inline for email compatibility) ────────────────
# bg=#0a0e17  surface=#111827  surface2=#1a2035  border=#1e2d45
# primary=#00d8ff (cyan)  success=#9fef00 (neon green)
# warning=#f59e0b  error=#ff4757  text=#e2e8f0  muted=#64748b
# mono: Courier New (email-safe monospace)
# ─────────────────────────────────────────────────────────────────────────────

def mono_block(value):
    """Render a monospace credential block."""
    return f"""<div style="background:#060c18;border:1px solid #1e2d45;border-left:3px solid #00d8ff;
                border-radius:6px;padding:10px 14px;font-family:'Courier New',Courier,monospace;
                font-size:13px;color:#00d8ff;word-break:break-all;letter-spacing:0.5px;">
        {value}
      </div>"""

def section_header(icon, title, subtitle=""):
    sub = f'<p style="margin:2px 0 0;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;">{subtitle}</p>' if subtitle else ""
    return f"""<tr>
        <td style="background:linear-gradient(90deg,#060c18,#0a0e17);padding:14px 20px;
                   border-bottom:1px solid #1e2d45;">
          <span style="font-size:20px;vertical-align:middle;">{icon}</span>
          <span style="color:#00d8ff;font-size:13px;font-weight:700;margin-left:10px;
                       text-transform:uppercase;letter-spacing:1.5px;vertical-align:middle;">{title}</span>
          {sub}
        </td>
      </tr>"""

def label(text):
    return f'<p style="margin:0 0 4px;color:#475569;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;">{text}</p>'

def field_row(lbl, value):
    return f"""<tr>
          <td style="padding:0 0 12px;">
            {label(lbl)}
            {mono_block(value)}
          </td>
        </tr>"""

html = f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>InfraWeaver Deployment</title>
</head>
<body style="margin:0;padding:0;background:#0a0e17;font-family:'Segoe UI',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:32px 16px;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

  <!-- ══ HEADER ════════════════════════════════════════════════════════════ -->
  <tr>
    <td style="background:linear-gradient(135deg,#0d1420 0%,#060c18 50%,#0a1628 100%);
               border-radius:14px 14px 0 0;padding:36px 40px 28px;text-align:center;
               border-top:3px solid #00d8ff;position:relative;overflow:hidden;">
      <!-- hex grid pattern via repeating background -->
      <div style="font-size:11px;color:#00d8ff;font-family:'Courier New',monospace;
                  letter-spacing:3px;margin-bottom:12px;opacity:0.6;">
        &#9632;&#9632;&#9632; INFRAWEAVER &#9632;&#9632;&#9632;
      </div>
      <h1 style="margin:0 0 4px;font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;">
        <span style="color:#00d8ff;">Infra</span>Weaver
      </h1>
      <p style="margin:0;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:3px;">
        Infrastructure, Woven Together
      </p>
    </td>
  </tr>

  <!-- ══ STATUS BAR ════════════════════════════════════════════════════════ -->
  <tr>
    <td style="background:#0d1420;padding:12px 40px;border-left:1px solid #1e2d45;
               border-right:1px solid #1e2d45;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <span style="background:#0a2010;color:#9fef00;font-size:11px;font-weight:700;
                         padding:4px 10px;border-radius:20px;border:1px solid #1a4020;
                         font-family:'Courier New',monospace;letter-spacing:1px;">
              ✓ DEPLOYMENT SUCCESSFUL
            </span>
            &nbsp;
            <span style="background:#0a1628;color:#00d8ff;font-size:11px;padding:4px 10px;
                         border-radius:20px;border:1px solid #1e2d45;font-family:'Courier New',monospace;">
              env: {env}
            </span>
          </td>
          <td align="right" style="color:#475569;font-size:11px;font-family:'Courier New',monospace;">
            {timestamp}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:8px;">
            <a href="{run_url}" style="color:#475569;font-size:11px;text-decoration:none;">
              &#128279; View GitHub Actions run →
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ══ BODY ══════════════════════════════════════════════════════════════ -->
  <tr>
    <td style="background:#0a0e17;padding:28px 40px;border-left:1px solid #1e2d45;
               border-right:1px solid #1e2d45;">

      <!-- ── STEP 1: Authentik SSO ─────────────────────────────────────── -->
      <p style="margin:0 0 8px;color:#00d8ff;font-size:11px;font-family:'Courier New',monospace;
                letter-spacing:2px;">STEP 1 OF 3</p>
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#111827;border:1px solid #1e2d45;border-radius:10px;
                    margin-bottom:20px;overflow:hidden;border-top:2px solid #00d8ff;">
        {section_header("🔑", "Authentik SSO — Login First", "All services use single sign-on")}
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 16px;color:#94a3b8;font-size:13px;line-height:1.6;">
              All services authenticate via Authentik SSO. Log in here first to access NetBird VPN and the homelab dashboard.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              {field_row("SSO Login URL", f'<a href="{auth_url}" style="color:#00d8ff;text-decoration:none;">{auth_url}</a>')}
              {field_row("Admin Email", "admin@rlservers.com")}
              {field_row("Admin Password", auth_admin_pass)}
              {field_row("Personal Login — Username", "remon")}
              {field_row("Personal Login — Set Password", f'<a href="{auth_recovery}" style="color:#9fef00;text-decoration:none;word-break:break-all;">{auth_recovery}</a>' if auth_recovery else "⚠️ Recovery link unavailable — use admin to reset manually")}
            </table>
          </td>
        </tr>
      </table>

      <!-- ── STEP 2: NetBird VPN ───────────────────────────────────────── -->
      <p style="margin:0 0 8px;color:#00d8ff;font-size:11px;font-family:'Courier New',monospace;
                letter-spacing:2px;">STEP 2 OF 3</p>
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#111827;border:1px solid #1e2d45;border-radius:10px;
                    margin-bottom:20px;overflow:hidden;border-top:2px solid #9fef00;">
        {section_header("🌐", "NetBird VPN — Connect to Homelab", "Required for all internal services")}
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 16px;color:#94a3b8;font-size:13px;line-height:1.6;">
              After logging in to Authentik, open the NetBird dashboard and connect the client.<br>
              All <code style="background:#060c18;color:#00d8ff;padding:2px 5px;border-radius:3px;font-size:12px;">*.int.rlservers.com</code> services require NetBird VPN.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              {field_row("NetBird Dashboard", f'<a href="{netbird_url}" style="color:#9fef00;text-decoration:none;">{netbird_url}</a>')}
              {field_row("Login Method", "Click &quot;Log in with SSO&quot; → Authentik")}
              {field_row("NetBird Management URL (for client setup)", "https://api.netbird.rlservers.com")}
            </table>
            <p style="margin:12px 0 0;color:#475569;font-size:11px;">
              &#128230; Download NetBird client: <a href="https://netbird.io/docs/installation" style="color:#00d8ff;text-decoration:none;">netbird.io/docs/installation</a>
            </p>
          </td>
        </tr>
      </table>

      <!-- ── STEP 3: Homelab Dashboard ─────────────────────────────────── -->
      <p style="margin:0 0 8px;color:#00d8ff;font-size:11px;font-family:'Courier New',monospace;
                letter-spacing:2px;">STEP 3 OF 3</p>
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#111827;border:1px solid #1e2d45;border-radius:10px;
                    margin-bottom:20px;overflow:hidden;border-top:2px solid #7c3aed;">
        {section_header("🏠", "Homelab Dashboard", "All services with live health status")}
        <tr>
          <td style="padding:20px;text-align:center;">
            <p style="margin:0 0 16px;color:#94a3b8;font-size:13px;">
              After connecting to NetBird VPN, open the dashboard to access all services.
            </p>
            <a href="{homepage_url}"
               style="display:inline-block;background:#00d8ff;color:#060c18;font-size:14px;
                      font-weight:900;padding:14px 36px;border-radius:8px;text-decoration:none;
                      letter-spacing:1px;font-family:'Courier New',monospace;">
              OPEN DASHBOARD &rarr;
            </a>
            <p style="margin:12px 0 0;color:#475569;font-size:11px;font-family:'Courier New',monospace;">
              {homepage_url}
            </p>
          </td>
        </tr>
      </table>

      <!-- ── OpenBao ───────────────────────────────────────────────────── -->
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#111827;border:1px solid #1e2d45;border-radius:10px;overflow:hidden;
                    border-top:2px solid #f59e0b;">
        {section_header("🔐", "OpenBao Vault", "All other credentials are stored here")}
        <tr>
          <td style="padding:20px;">
            <p style="margin:0 0 16px;color:#94a3b8;font-size:13px;line-height:1.6;">
              The vault stores all platform secrets. Access via VPN after unsealing.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              {field_row("Vault URL", f'<a href="{openbao_url}" style="color:#00d8ff;text-decoration:none;">{openbao_url}</a>')}
              {field_row("Root Token", bao_token)}
              {field_row("Unseal Key", bao_unseal)}
            </table>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- ══ FOOTER ════════════════════════════════════════════════════════════ -->
  <tr>
    <td style="background:#060c18;padding:20px 40px;border-radius:0 0 14px 14px;
               border:1px solid #1e2d45;border-top:1px solid #1e2d45;text-align:center;">
      <p style="margin:0;color:#1e2d45;font-size:10px;font-family:'Courier New',monospace;
                letter-spacing:1px;">
        INFRAWEAVER PLATFORM &nbsp;·&nbsp; ALL CREDENTIALS RANDOMLY GENERATED PER DEPLOYMENT &nbsp;·&nbsp; KEEP THIS EMAIL SECURE
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

STEP 1: Log in to Authentik SSO
  URL       : {auth_url}
  Admin     : admin@rlservers.com / {auth_admin_pass}
  Personal  : remon / set your password: {auth_recovery if auth_recovery else "(recovery link unavailable — reset via admin)"}

STEP 2: Connect NetBird VPN
  Dashboard : {netbird_url}
  Login via : SSO (Authentik)
  Mgmt URL  : https://api.netbird.rlservers.com (for client setup)
  Client    : https://netbird.io/docs/installation

STEP 3: Open Homelab Dashboard (requires VPN)
  URL       : {homepage_url}

OPENBAO VAULT — all other credentials stored here
  URL       : {openbao_url}  (requires VPN)
  Token     : {bao_token}
  Unseal    : {bao_unseal}
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
