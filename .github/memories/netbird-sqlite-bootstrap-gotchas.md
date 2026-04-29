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
