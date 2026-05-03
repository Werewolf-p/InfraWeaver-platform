---
title: NetBird v0.70 PAT Token Format & Bootstrap
description: Valid 40-char PAT format, hash storage, and bootstrap automation for NetBird management
---

# NetBird v0.70 PAT Token Format & Bootstrap

## Memory

- **File paths:**
  - `kubernetes/platform/netbird/manifests/bootstrap-job.yaml` — PostSync job
  - `kubernetes/platform/netbird/manifests/externalsecret.yaml` — reads PAT from OpenBao
  - `.github/workflows/full-redeploy.yml` — generates PAT and stores in OpenBao

- **PAT token format (40 chars total):**
  - Structure: `nbp_` (4) + secret (30 base62 chars) + CRC32 checksum (6 base62 chars)
  - Alphabet: `0-9A-Za-z` (digits first, then uppercase, then lowercase)
  - CRC32 must encode to EXACTLY 6 base62 chars (CRC32 >= 62^5 = 916,132,832)
  - Go uses `fmt.Sprintf("%06s", encoded)` which space-pads for strings — tokens with CRC32 < 62^5 will have space padding and fail validation
  - Generation one-liner (shell-safe, YAML-safe, single-quoted):
    ```bash
    python3 -c 'import zlib,random,string; a=string.digits+string.ascii_uppercase+string.ascii_lowercase; b62=lambda n,s="": s if not n else b62(n//62,a[n%62]+s); t=next(s for s in iter(lambda:"".join(random.choices(a,k=30)),None) if len(b62(zlib.crc32(s.encode())&4294967295))==6); print("nbp_"+t+b62(zlib.crc32(t.encode())&4294967295))'
    ```

- **Hash storage (DB `personal_access_tokens.hashed_token`):**
  - `base64(sha256(full_40_char_token))` — standard base64 encoding
  - Python: `base64.b64encode(hashlib.sha256(token.encode()).digest()).decode()`
  - Bootstrap computes hash dynamically from `PAT_TOKEN` env var (no hardcoding)

- **OpenBao path:** `secret/platform/netbird` → key `netbird-pat-token`

- **Bootstrap flow:**
  1. ArgoCD PostSync hook runs `netbird-db-bootstrap` job
  2. Job scales management to 0, writes DB (account, user, setup key, PAT, route), scales to 1
  3. Waits for `/api/peers` with PAT auth to confirm management is fully ready
  4. Creates `prod-local` DNS nameserver group (10.25.0.201 for `prod.local`) via API

- **Why it matters:** Using a 47-char or incorrectly-checksummed token results in "token invalid" error from the management API even if the DB hash is correct. NetBird v0.70 validates token structure before DB lookup.

- **Validation:** `curl http://10.25.0.203/api/peers -H "Authorization: Token <pat>"` should return JSON array

- **Lesson learned:** Python multiline heredocs inside GitHub Actions `run: |` YAML blocks cause YAML parse errors because heredoc content at column 0 terminates the YAML block scalar. Always use single-line `python3 -c '...'` with single quotes.
