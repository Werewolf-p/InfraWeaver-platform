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
- **Authentik admin/remon passwords:** extracted via `kubectl exec -n openbao openbao-0 -- vault kv get -field=...`
- **NetBird VPN info:** management URL `https://netbird.rlservers.com` (public, never `.int.`)

## Email Content (InfraWeaver Prime design — 2026-04-30)

Three-step layout with dark hacker aesthetic (navy #0a0e17, cyan #00d8ff, neon green #9fef00):

1. **Step 1 — Authentik SSO:** `https://auth.rlservers.com` + admin + remon credentials
2. **Step 2 — NetBird VPN:** `https://netbird.rlservers.com` with setup instructions
3. **Step 3 — Homepage Dashboard:** `https://home.int.rlservers.com` (VPN required)
4. **OpenBao vault credentials** — root token + unseal key (cannot be stored in vault)

**Do NOT include:** any other service passwords — all in OpenBao vault.

**CRITICAL — NetBird URL:** Always use `https://netbird.rlservers.com` (public). Never `.int.rlservers.com` for NetBird management — users need it BEFORE they have VPN access.

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
