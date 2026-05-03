---
title: IAC Incremental Deploy — apply-changes.yml Pattern
description: How incremental deploys work, when to use them vs full-redeploy, and common gotchas.
---

# IAC Incremental Deploy

## Overview

Day-to-day changes go through `apply-changes.yml` (never full-redeploy unless the cluster is broken).
Full-redeploy triggers cert issuance and risks hitting Let's Encrypt rate limits.

```
push to main
  → apply-changes.yml (if changed files match paths)
    → Detect Changes       (ubuntu-latest, fast)
    → Seed OpenBao         (prod-worker, seeds new user passwords)
    → Sync Blueprints      (skipped unless blueprint-*.yaml changed)
    → Apply User Config    (syncs Authentik groups + generates recovery links)
    → Send Notification    (skipped unless send_recovery_email input set)
```

---

## Trigger Paths

`apply-changes.yml` triggers on push when ANY of these files change:

```
users.yaml
kubernetes/platform/authentik/manifests/blueprint-users.yaml
kubernetes/platform/authentik/manifests/blueprint-access-control.yaml
kubernetes/platform/authentik/manifests/blueprint-*.yaml
kubernetes/platform/authentik/values.yaml
.github/scripts/seed-openbao-authentik.sh
```

ArgoCD auto-syncs ALL `kubernetes/**` changes automatically (every ~3 min) — no workflow needed for K8s manifests.

---

## Adding a New User (IAC)

Edit 5 files — commit — done. No workflow changes needed.

1. **`users.yaml`** — add user entry (name, email, access_level, authentik_groups, send_recovery_email)
2. **`kubernetes/platform/authentik/manifests/blueprint-users.yaml`** — add `authentik_core.user` entry using `!Env AUTHENTIK_USERNAME_PASSWORD`
3. **`kubernetes/platform/authentik/manifests/externalsecret.yaml`** — add `username-password` key mapping
4. **`kubernetes/platform/authentik/values.yaml`** — add env var `AUTHENTIK_USERNAME_PASSWORD` with `optional: true`
5. **`.github/scripts/seed-openbao-authentik.sh`** — add password in both the initial create block and the patch-if-missing block

`apply-changes.yml` auto-triggers on the commit (values.yaml or blueprint change detected).

### Why `optional: true` on user password secretKeyRefs

ArgoCD may auto-sync `externalsecret.yaml` before the Seed OpenBao job writes the new password.
If `secretKeyRef.optional` is `false` (default), the Authentik pod fails to start when the key is absent.
`optional: true` means the pod starts with an empty env var — the password is set by the blueprint
once OpenBao has synced the key. **Core secrets (secret-key, postgresql-password, bootstrap-*) remain required.**

---

## kubectl exec Pattern (Critical)

**Always use `--field-selector=status.phase=Running` when getting the worker pod.**

During a rolling update, `kubectl get pod -l ... -o jsonpath='{.items[0].metadata.name}'`
may return the NEW (crashing) pod, not the OLD (running) pod. Exeucting into a crashing pod
gives "container not found" or "exec failed".

```bash
# CORRECT: select Running pod first, fall back if filter finds nothing
WORKER_POD=$(kubectl get pod -n authentik \
  -l app.kubernetes.io/component=worker \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || \
  kubectl get pod -n authentik \
  -l app.kubernetes.io/component=worker \
  -o jsonpath='{.items[0].metadata.name}')

# CORRECT: use -i flag and pipe stdin
cat /tmp/script.py | kubectl exec -i -n authentik "$WORKER_POD" -- ak shell
```

---

## Manual Dispatch

```bash
# Force user sync (without changing files)
gh workflow run apply-changes.yml \
  --repo Werewolf-p/InfraWeaver-platform \
  --ref main \
  --field force_user_sync=true

# Force user sync + send recovery email
gh workflow run apply-changes.yml \
  --repo Werewolf-p/InfraWeaver-platform \
  --ref main \
  --field force_user_sync=true \
  --field send_recovery_email=true
```

---

## Dynamic Scripts

- **`sync-authentik-users.py`** — reads `users.yaml`, generates Django ORM group sync script piped to `ak shell`
- **`list-recovery-users.py`** — reads `users.yaml`, prints usernames with `send_recovery_email: true`
- Adding a user to `users.yaml` automatically includes them in both scripts — no hardcoded lists

---

## When to Use Full Redeploy

Only when the cluster is genuinely broken (etcd corrupt, Talos reinstall needed, etc.).

Full redeploy destroys and recreates:
- Talos cluster (all nodes)
- All Kubernetes resources
- Let's Encrypt certs (risk rate limits — max 5 certs per registered domain per week)

**Do NOT use full-redeploy for user changes, config changes, or new services.**
Those go through apply-changes.yml or ArgoCD auto-sync.

---

## Related Files

- `.github/workflows/apply-changes.yml` — incremental deploy workflow
- `.github/workflows/full-redeploy.yml` — full cluster rebuild (emergency only)
- `users.yaml` — single source of truth for all platform users
- `.github/scripts/sync-authentik-users.py` — dynamic group sync
- `.github/scripts/list-recovery-users.py` — dynamic recovery link list
- `.github/scripts/seed-openbao-authentik.sh` — seeds user passwords into OpenBao
