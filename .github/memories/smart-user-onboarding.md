# Smart User Onboarding & Email Flow

## Overview
Users are managed via `users.yaml` (single source of truth). The `apply-changes.yml` 
workflow handles all incremental user changes with zero admin email noise.

## New User Detection
- `list-recovery-users.py --new-only`: compares `users.yaml` HEAD~1 vs HEAD using git diff
- Returns ONLY usernames that appear in new commit but NOT in previous commit
- Falls back to all users if no git history (first commit)
- Requires `fetch-depth: 2` on checkout (already set in apply-changes.yml)

## Email Logic
| Event | Email Sent | To |
|-------|-----------|-----|
| New user added | Welcome email with recovery link | User's `email` from users.yaml |
| Existing user changed | NOTHING | — |
| Full redeploy | Admin summary email | SMTP_TO secret |

## apply-changes.yml Jobs
1. `detect` — detects `user_config` changed + emits `new_users` JSON list
2. `seed-openbao` — runs only if `user_config=true` or `force_user_sync=true`
3. `sync-blueprints` — runs only if `blueprint_config=true`
4. `apply-users` — syncs groups + generates recovery links for NEW users only
5. `welcome-emails` — sends per-user welcome email; SKIPPED when `new_users == []`
6. `post-health-check` — always runs; checks public endpoints + ArgoCD app health

## Group Auto-Derivation (sync-authentik-users.py)
```python
ACCESS_LEVEL_GROUPS = {
    "admin": ["platform-admins", "authentik Admins", "platform-users"],
    "platform-user": ["platform-users"],
}
```
- If `authentik_groups` is set in users.yaml → use explicit list
- Otherwise → auto-derive from `access_level`

## Recovery Link Env Convention
- Pattern: `AUTHENTIK_{USERNAME.upper()}_RECOVERY_LINK`
- e.g. `AUTHENTIK_REMON_RECOVERY_LINK`, `AUTHENTIK_ARDATY_RECOVERY_LINK`
- Generated in `apply-users` job, stored in `recovery_links_json` output (JSON dict)
- Read by `welcome-emails` job and `send-welcome-email.py`

## Welcome Email Script
- `scripts/send-welcome-email.py --username X --recovery-link Y`
- Reads user's email from `users.yaml`
- Sends to user's own email (NOT the admin SMTP_TO)
- Skips gracefully if email missing/invalid

## ArgoCD Application Names
- Authentik: `apps-authentik-manifests`
- Netbird: `apps-netbird`
- Test website: `apps-test-website`
- Use these names in health checks, NOT the Helm chart names

## Adding a New User (checklist)
1. `users.yaml`: add entry with `name`, `email`, `access_level`, `send_recovery_email: true`
2. `blueprint-users.yaml`: add user object
3. `seed-openbao-authentik.sh`: add password secret
4. `externalsecret.yaml` + `authentik/values.yaml`: add password env var
5. Push → apply-changes.yml auto-syncs groups + sends welcome email to user

## Validated Tests
- testuser-ci added → `new_users=["testuser-ci"]` → welcome email fires ✅
- testuser-ci removed → `new_users=[]` → Send Welcome Emails job SKIPPED ✅
- Manual dispatch with `force_user_sync=true` → Apply User Config runs ✅
- Post-health check: public endpoints + ArgoCD Synced+Healthy ✅
