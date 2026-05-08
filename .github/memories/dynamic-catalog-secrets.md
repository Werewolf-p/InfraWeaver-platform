---
title: Dynamic catalog secrets architecture
description: Declarative secrets schema in catalog.yaml drives OpenBao seeding automatically — no more hardcoded per-app blocks.
---

# Dynamic Catalog Secrets Architecture

## Memory

- **File paths:**
  - `scripts/seed-catalog-secrets.sh` — main seeding script
  - `scripts/deploy/bootstrap-openbao.sh` — calls seed script after OpenBao init
  - `kubernetes/catalog/<app>/catalog.yaml` — `secrets:` section per app
- **Decision:** Replace hardcoded wiki/gitea/forgejo/vaultwarden blocks in bootstrap-openbao.sh with a data-driven approach using `catalog.yaml` secrets declarations
- **Why it matters:** Adding a new catalog app previously required modifying bootstrap-openbao.sh (fragile, easy to forget). Now it only requires a `secrets:` section in catalog.yaml.
- **Validation:** Run `OPENBAO_ADDR=http://... VAULT_TOKEN=... bash scripts/seed-catalog-secrets.sh --dry-run`
- **Related:** `scripts/sync-catalog.sh`, `platform.yaml`, `scripts/validate-eso-refs.sh`

## catalog.yaml Secrets Schema

```yaml
secrets:
  path: platform/<app>           # OpenBao KV path (secret/data/<path>)
  keys:
    <key-name>:
      type: password             # openssl rand -base64 24, unique per deploy
      # or
      type: static
      value: "literal-value"    # e.g. admin-email, oidc-client-id
      # optional for password type:
      length: 32                # default: 24
```

## OpenBao Path Convention

| App | OpenBao path | Keys |
|-----|-------------|------|
| wiki | `secret/data/platform/wiki` | admin-email, admin-password, postgresql-username, postgresql-password, oidc-client-id, oidc-client-secret |
| onedev | `secret/data/platform/onedev` | admin-login, admin-password, admin-email, oidc-client-id, oidc-client-secret |
| gitea | `secret/data/platform/gitea` | admin-user, admin-password, admin-email, postgresql-password, oidc-client-id, oidc-client-secret |
| vaultwarden | `secret/data/platform/vaultwarden` | admin-token |

## Idempotency Guarantee

The seed script uses **read-modify-write**:
1. Read existing values from OpenBao for the app's path
2. Only generate values for keys that don't exist yet
3. Write only the new keys (using KV v2 patch where supported)
4. Existing passwords are NEVER overwritten

This means redeploys are safe — user passwords set post-deploy are preserved.

## Adding a New Catalog App With Secrets

1. Create `kubernetes/catalog/<app>/catalog.yaml` with a `secrets:` section
2. Add `<app>` to `platform.yaml` under `catalog.enabled`
3. Run `scripts/sync-catalog.sh` (or push to main — it runs automatically)
4. On next deploy, `bootstrap-openbao.sh` calls `seed-catalog-secrets.sh`
   which reads catalog.yaml and seeds the secrets automatically
5. Add ExternalSecrets in the app's manifests referencing `secret/platform/<app>`

## Lesson Learned

The old approach (hardcoded blocks) required 15-25 lines per app in bootstrap-openbao.sh.
Each block had to be written correctly, tested, and was easy to have copy-paste bugs
(e.g., forgejo block used `postgres-password` vs gitea's `postgresql-password`).
The declarative approach is self-documenting and the same code path handles all apps.
