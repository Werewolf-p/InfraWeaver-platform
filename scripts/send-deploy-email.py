#!/usr/bin/env python3
"""
Send deployment summary email with platform credentials.
Expected environment variables:
  SMTP_USERNAME, SMTP_PASSWORD, SMTP_TO,
  DEPLOY_ENV, DEPLOY_RUN_URL,
  BAO_TOKEN, BAO_UNSEAL, NB_PAT, NB_SETUP, ARGO_PASS, GRAFANA_PASS
"""
import smtplib, ssl, os, sys
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

smtp_host  = "smtp-mail.outlook.com"
smtp_port  = 587
smtp_user  = os.environ["SMTP_USERNAME"]
smtp_pass  = os.environ["SMTP_PASSWORD"]
smtp_to    = os.environ["SMTP_TO"]

env        = os.environ.get("DEPLOY_ENV", "unknown")
run_url    = os.environ.get("DEPLOY_RUN_URL", "")
bao_token  = os.environ.get("BAO_TOKEN", "unavailable")
bao_unseal = os.environ.get("BAO_UNSEAL", "unavailable")
nb_pat     = os.environ.get("NB_PAT", "unavailable")
nb_setup   = os.environ.get("NB_SETUP", "unavailable")
argo_pass  = os.environ.get("ARGO_PASS", "unavailable")
grafana    = os.environ.get("GRAFANA_PASS", "check-openbao")

subject = f"[InfraWeaver] {env} deployment complete — login credentials"

body = f"""\
InfraWeaver Platform — Full Redeployment Complete
==================================================
Environment : {env}
Run         : {run_url}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OpenBao (Vault)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UI          : http://openbao.prod.local  (via NetBird VPN)
Root Token  : {bao_token}
Unseal Key  : {bao_unseal}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NetBird VPN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Management  : https://netbird.rlservers.com
PAT Token   : {nb_pat}
Setup Key   : {nb_setup}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ArgoCD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL         : http://argocd.prod.local  (via NetBird VPN)
Username    : admin
Password    : {argo_pass}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Grafana
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL         : http://grafana.prod.local  (via NetBird VPN)
Username    : admin
Password    : {grafana}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Longhorn Storage
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL         : http://longhorn.prod.local  (via NetBird VPN)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Access via NetBird
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Connect     : netbird up --management-url https://netbird.rlservers.com --setup-key {nb_setup}
All services are only accessible after connecting to NetBird VPN.
"""

msg = MIMEMultipart("alternative")
msg["Subject"] = subject
msg["From"]    = smtp_user
msg["To"]      = smtp_to
msg.attach(MIMEText(body, "plain"))

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
