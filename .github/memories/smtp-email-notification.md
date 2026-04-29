---
title: SMTP Email Notification on Full Redeployment
description: Sends styled HTML deployment summary email with OpenBao + NetBird credentials after full-redeploy.yml completes
---

# SMTP Email Notification After Full Redeployment

## Memory

- **File paths:**
  - `.github/workflows/full-redeploy.yml` — "Send deployment summary email" step at end of job
  - `scripts/send-deploy-email.py` — standalone Python email script (HTML + plaintext multipart)
- **Decision:** Python script in `scripts/` rather than inline — YAML `<<` heredoc syntax conflicts with YAML merge key parser
- **SMTP config:** `smtp-mail.outlook.com:587` with STARTTLS (`smtplib.SMTP` + `s.starttls()`)
- **Credentials stored as GitHub Secrets:** `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TO`

## Credential Collection Strategy

- **OpenBao root token + unseal key:** from K8s `openbao-unseal` secret in `openbao` namespace (always available)
- **NetBird PAT + SETUP_KEY:** read via `kubectl exec -n openbao openbao-0 -- vault kv get -field=... secret/platform/netbird`
  - **Why exec and not K8s secret:** `netbird-secrets` ExternalSecret may not yet be synced when email step runs — vault exec is always reliable
  - **VAULT_TOKEN** and **VAULT_ADDR=http://127.0.0.1:8200** must be set inside the exec command

## Email Content (simplified per user preference)
- OpenBao: root token + unseal key + dashboard URL
- NetBird: PAT token + setup key + management URL + connect command
- Services table: ArgoCD, Grafana, Longhorn, OpenBao UI (URLs only — all creds in OpenBao)
- **Do NOT include** ArgoCD/Grafana passwords in email — user wants minimal, all other creds in vault

## Design
- HTML multipart email with dark InfraWeaver theme (navy/blue gradient)
- Card layout with monospace code blocks for tokens
- Plaintext fallback for non-HTML clients

## Validation
- Run `gh workflow run full-redeploy.yml --field environment=productie --field confirm=DESTROY`
- Check Gmail inbox for `🚀 InfraWeaver | productie deployment complete`
- Verify NetBird PAT and Setup Key are populated (not empty)

## Lesson Learned
- ExternalSecret sync timing: at time of email step, `netbird-secrets` K8s secret may not yet be synced by external-secrets operator → always use vault exec for netbird creds
- Never use `<< HEREDOC` inside YAML `run: |` block — YAML parser interprets `<<` as merge key even in block scalars
