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

## Authentik SMTP (in-cluster)

- **K8s secret:** `authentik-smtp-secret` in namespace `authentik` — created directly from GitHub secrets (`SMTP_USERNAME`, `SMTP_PASSWORD`) during "Bootstrap OpenBao + ExternalSecrets" step
- **values.yaml env vars:** `AUTHENTIK_EMAIL__USERNAME` + `AUTHENTIK_EMAIL__PASSWORD` from `authentik-smtp-secret`
- **Non-secret SMTP config:** in `kubernetes/platform/authentik/values.yaml` under `authentik.email` (`host`, `port`, `use_tls`, `from`)
- **Timing is safe:** SMTP secret is created before ArgoCD can make Authentik healthy (Authentik depends on `authentik-secrets` via ESO, which also requires the same bootstrap step)

## Credential Collection Strategy (as of 2026-05-02)

- **OpenBao root token + unseal key:** from K8s `openbao-unseal` secret in `openbao` namespace (always available)
- **Authentik admin password:** extracted via `kubectl exec -n openbao openbao-0 -- vault kv get -field=bootstrap-password secret/platform/authentik`
- **Remon password reset link:** generated via Authentik REST API `POST /api/v3/core/users/{id}/recovery/` → stored in `$GITHUB_ENV` as `AUTHENTIK_RECOVERY_LINK` → passed to email step via `env: AUTHENTIK_RECOVERY_LINK: ${{ env.AUTHENTIK_RECOVERY_LINK }}`
- **NetBird VPN info:** management URL `https://netbird.rlservers.com` (public, never `.int.`)

## Passing Values Between Steps (CRITICAL)

- `export VAR=value` does NOT persist between GitHub Actions steps
- Use `echo "VAR=value" >> $GITHUB_ENV` to persist to subsequent steps
- Receive in the next step via `env: VAR: ${{ env.VAR }}`
- This is how `AUTHENTIK_RECOVERY_LINK` is passed from "Set Authentik admin privileges" → "Send deployment summary email"

## Email Content (InfraWeaver Prime design — 2026-04-30)

Three-step layout with dark hacker aesthetic (navy #0a0e17, cyan #00d8ff, neon green #9fef00):

1. **Step 1 — Authentik SSO:** `https://auth.rlservers.com` + admin password + remon password-reset link (clickable URL)
2. **Step 2 — NetBird VPN:** `https://netbird.rlservers.com` with setup instructions
3. **Step 3 — Homepage Dashboard:** `https://home.int.rlservers.com` (VPN required)
4. **OpenBao vault credentials** — root token + unseal key (cannot be stored in vault)

**Do NOT include:** remon's actual password — only the recovery link. **Do NOT include:** any other service passwords — all in OpenBao vault.

**CRITICAL — NetBird URL:** Always use `https://netbird.rlservers.com` (public). Never `.int.rlservers.com` for NetBird management — users need it BEFORE they have VPN access.

## Design
- HTML multipart email with dark InfraWeaver theme (navy/blue gradient)
- Card layout with monospace code blocks for tokens
- Plaintext fallback for non-HTML clients
- Step uses `if: always()` to send even if earlier steps fail

## Validation
- Run `gh api -X POST repos/Werewolf-p/InfraWeaver-platform/actions/workflows/266231748/dispatches -f ref=main -f "inputs[environment]=productie" -f "inputs[confirm]=DESTROY"`
- Check inbox for `⚡ InfraWeaver | productie deployment complete`
- Verify email shows: admin password, remon password reset URL, OpenBao token/unseal key

## Lessons Learned
- Never use `<< HEREDOC` inside YAML `run: |` block — YAML parser interprets `<<` as merge key even in block scalars
- **CRITICAL — Column-0 Python in YAML block scalars:** Any content (Python, bash heredoc body) at column 0 inside a `run: |` block terminates the YAML block scalar prematurely. GitHub returns "Workflow does not have 'workflow_dispatch' trigger" when the YAML is invalid — misleading error. Fix: base64-encode multi-line Python and pipe via `echo "$B64" | base64 -d | kubectl exec -i ... ak shell`
- ExternalSecret sync timing issue: if adding vault secrets back to email, use `kubectl exec -n openbao openbao-0 -- vault kv get` (not K8s secret) — ExternalSecret may not yet be synced when email step runs
