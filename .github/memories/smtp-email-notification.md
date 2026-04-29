---
title: SMTP Email Notification on Full Redeployment
description: Sends deployment summary email with all platform credentials after full-redeploy.yml completes
---

# SMTP Email Notification After Full Redeployment

## Memory

- **File paths:**
  - `.github/workflows/full-redeploy.yml` — "Send deployment summary email" step at end of job
  - `scripts/send-deploy-email.py` — standalone Python email script (avoids YAML heredoc issues)
- **Decision:** Python script is in `scripts/` rather than inline in the workflow because YAML `<<` heredoc syntax conflicts with YAML merge key parser
- **SMTP config:** `smtp-mail.outlook.com:587` with STARTTLS (`smtplib.SMTP` + `s.starttls()`)
- **Credentials stored as GitHub Secrets:** `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TO`
- **Credentials collected from cluster:**
  - OpenBao root token + unseal key: `openbao-unseal` secret in `openbao` namespace
  - NetBird PAT + setup key: `netbird-secrets` secret in `netbird` namespace
  - ArgoCD password: `argocd-initial-admin-secret` in `argocd` namespace
  - Grafana password: `grafana-admin-secret` in `apps-grafana` namespace
- **Why it matters:** Full redeployment regenerates all random credentials — email ensures admin always has current creds
- **Validation:** Run `gh workflow run full-redeploy.yml --field environment=productie --field confirm=DESTROY` and check Gmail inbox
- **Lesson learned:** Never use `<< HEREDOC` inside a YAML `run: |` block — YAML parser interprets `<<` as a merge key even in block scalars; write Python to a file in `scripts/` instead
