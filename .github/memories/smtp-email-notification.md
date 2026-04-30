---
title: SMTP Email Notification on Full Redeployment
description: Sends styled HTML deployment summary email with OpenBao root credentials and homepage link after full-redeploy.yml completes.
---

# SMTP Email Notification After Full Redeployment

## Memory

- **File paths:**
  - `.github/workflows/full-redeploy.yml` — "Send deployment summary email" step at end of job
  - `scripts/send-deploy-email.py` — standalone Python email script (HTML + plaintext multipart)
- **Decision:** Python script in `scripts/` rather than inline — YAML `<<` heredoc syntax conflicts with YAML merge key parser
- **SMTP config:** `smtp-mail.outlook.com:587` with STARTTLS (`smtplib.SMTP` + `s.starttls()`)
- **Credentials stored as GitHub Secrets:** `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TO`

## Credential Collection Strategy (as of 2026-04-30)

- **OpenBao root token + unseal key:** from K8s `openbao-unseal` secret in `openbao` namespace (always available)
- **All other credentials:** intentionally NOT in email — user retrieves them from OpenBao after connecting to VPN

## Email Content (minimised per user preference — 2026-04-30)

Keep the email minimal. Only include:
1. **Homepage dashboard link** (`https://home.rlservers.com`) — with note that NetBird VPN is required
2. **OpenBao vault credentials** — root token + unseal key (these cannot be stored in the vault)

**Do NOT include in email:**
- NetBird PAT token (user has admin account via SSO, no PAT needed)
- NetBird setup key (in OpenBao `secret/platform/netbird`)
- Authentik password (in OpenBao `secret/platform/authentik`)
- Any service passwords or setup keys — all in OpenBao

## Design
- HTML multipart email with dark InfraWeaver theme (navy/blue gradient)
- Card layout with monospace code blocks for tokens
- Plaintext fallback for non-HTML clients
- Step uses `if: always()` to send even if earlier steps fail

## Validation
- Run `gh workflow run full-redeploy.yml --field environment=productie --field confirm=DESTROY`
- Check inbox for `🚀 InfraWeaver | productie deployment complete`
- Verify email shows homepage link + OpenBao token/unseal key only

## Lesson Learned
- Never use `<< HEREDOC` inside YAML `run: |` block — YAML parser interprets `<<` as merge key even in block scalars
- ExternalSecret sync timing issue: if adding vault secrets back to email, use `kubectl exec -n openbao openbao-0 -- vault kv get` (not K8s secret) — ExternalSecret may not yet be synced when email step runs
