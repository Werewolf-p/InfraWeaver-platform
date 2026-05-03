---
title: NetBird v0.70 SQLite DB Bootstrap Gotchas
description: Critical format requirements for NetBird v0.70 SQLite data to avoid migratePreAuto gob decode crashes
---

# NetBird v0.70 SQLite DB Bootstrap Gotchas

## Memory

- **File paths:** `kubernetes/apps/netbird/manifests/bootstrap-job.yaml`

- **routes.network must be JSON-encoded string:**
  - Store as `'"10.25.0.0/24"'` (with inner double quotes), NOT `'10.25.0.0/24'`
  - Python: `json.dumps("10.25.0.0/24")` = `'"10.25.0.0/24"'`
  - `migratePreAuto` calls `MigrateFieldFromGobToJSON` — if value is not valid JSON, it gob-decodes it and **crashes**
  - Plain CIDR string without quotes is not valid JSON → gob decode → unexpected EOF → management pod CrashLoopBackOff

- **accounts.network_net must be JSON object:**
  - Format: `'{"IP": "100.64.0.0", "Mask": "/8AAAA=="}'`
  - Mask is base64 of the raw bytes of the subnet mask

- **routes.peer_groups must be JSON array:**
  - Format: `'["grp00000-0000-4000-a000-000000000001"]'`

- **DataStoreEncryptionKey (AES-256-GCM):**
  - If set in management.json, user name/email and PAT name are encrypted
  - Format: `base64(nonce[12] + AESGCM.encrypt(nonce, plaintext, None))`
  - Python: `from cryptography.hazmat.primitives.ciphers.aead import AESGCM`
  - Key is base64-decoded before use: `AESGCM(base64.b64decode(key_str))`

- **PVC node affinity:** `netbird-management-data` PVC uses `local-path` storage class
  - PV has node affinity to `talos-prod-cp1`
  - Bootstrap job must run on same node: use `nodeName: talos-prod-cp1` or let scheduler handle it

- **WAL corruption rule (CRITICAL):**
  - NEVER run `PRAGMA journal_mode=DELETE` or `PRAGMA journal_mode=WAL` on management's DB files
  - NEVER write to DB while management is running
  - Bootstrap job scales management to 0, writes, scales back to 1

- **Why it matters:** Wrong DB format causes management to crash on startup with `gob decode error: unexpected EOF` in `migratePreAuto`. This is a silent data format issue, not a code bug.

- **Validation:** `kubectl logs netbird-management-0 | grep "accounts number"` should show `accounts number 1`

## Bootstrap Job Deadlock Pattern (May 2026)

**Symptom:** Bootstrap job gets stuck, management pod is at 0 replicas, ArgoCD keeps recreating the job.

**Root cause:** 
1. Bootstrap job init container waits for management HTTP API to be ready
2. Bootstrap job main container scales management to 0 (to safely write DB)
3. If management pod never fully started (first deploy, TLS not ready, OIDC failure), the management API was never available
4. Init container times out → job fails → ArgoCD recreates → new job immediately scales management to 0 → deadlock

**The deadlock loop:**
```
management pod (PodInitializing, waiting for TLS/OIDC)
  → bootstrap job init container waits for API
  → init timeout → job Completes with error
  → ArgoCD recreates job
  → new job's main container scales management to 0
  → management never gets to start
  → same init container waits forever
```

**Breaking the deadlock manually:**
```bash
KB="kubectl --kubeconfig ~/.kube/config-platform-productie --insecure-skip-tls-verify"
$KB delete job netbird-db-bootstrap -n netbird
$KB scale statefulset netbird-management -n netbird --replicas=1
# Wait for management to start fully (TLS cert must be ready first)
# Then ArgoCD will recreate bootstrap job which will succeed
```

**Prevention:**
- Ensure TLS cert (`rlservers-com-wildcard`) is Ready before NetBird management starts
- NetBird management init container `wait-for-oidc` uses `curl -sfk` (not `-sf`) to allow self-signed TLS
- The management binary itself validates OIDC endpoint TLS, so cert must be valid before management starts

## NetBird Management TLS Requirement

NetBird management validates TLS of the OIDC discovery URL at startup:
`tls: failed to verify certificate: x509: certificate is valid for traefik.default, not auth.rlservers.com`

Fix: The init container `wait-for-oidc` uses `curl -sfk` to check health without validating TLS.
But the management binary itself still validates. So `rlservers-com-wildcard-tls` must be issued
before management can start successfully.

If TLS cert is being restored from backup (common scenario), management starts immediately.
If TLS cert needs to be re-issued (rate limited/fresh deploy with empty backup), there's a race
condition — management will fail to start until the cert is issued (~5 min for HTTP-01).
