---
title: All user-specific values must use .env placeholders
description: No hardcoded usernames, emails, or domains — use ${VAR} substituted by generate-from-env.sh
---

# Dynamic .env Placeholder Pattern

## Memory

- **File paths:**
  - `kubernetes/platform/authentik/manifests/blueprint-users.yaml` — platform admin user
  - `kubernetes/platform/authentik/values.yaml` — AUTHENTIK_BOOTSTRAP_EMAIL
  - `kubernetes/core/cert-manager/manifests/cluster-issuer.yaml` — ACME registration email
  - `kubernetes/catalog/onedev/manifests/admin-config.yaml` — Onedev admin user

- **Decision:** All user-facing values (username, display name, email, domain) must use `${VAR}` placeholders that `generate-from-env.sh` substitutes at deploy time.

- **Placeholder mapping:**
  | Placeholder | .env key | Example value |
  |-------------|----------|---------------|
  | `${ADMIN_USERNAME}` | `ADMIN_USERNAME` | `remon` |
  | `${ADMIN_NAME}` | `ADMIN_NAME` | `remon` |
  | `${ADMIN_EMAIL}` | `ADMIN_EMAIL` | `remonhulst@gmail.com` |
  | `${BASE_DOMAIN}` | `BASE_DOMAIN` | `rlservers.com` |
  | `AUTHENTIK_BOOTSTRAP_EMAIL` | derived from `BASE_DOMAIN` | `akadmin@rlservers.com` |

- **Why it matters:** Hardcoded values caused `akadmin` and platform-owner to share the same email → Authentik identification stage could resolve to the wrong user → login failure with "invalid password".

- **Validation:** Run `grep -rn "remonhulst\|\"remon\"" kubernetes/ scripts/` after any change — should return zero matches.

- **Related:** `scripts/generate-from-env.sh` — processes all `*.yaml` and `*.tfvars` under `kubernetes/` and `envs/` dirs.

- **Lesson learned:** After fixing one hardcode, do a global grep scan across the whole repo. Stale values cluster — finding one means there are others.
