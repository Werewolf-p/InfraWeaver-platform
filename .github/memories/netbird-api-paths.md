---
title: NetBird Management API — correct paths
description: NetBird REST API uses /api/ prefix without version number, not /api/v1/
---

# NetBird Management API Paths

## Memory

- **File paths:** `scripts/init/server.py` (`_check_netbird_token`), `kubernetes/catalog/gatus/manifests/all.yaml`
- **Decision:** NetBird management HTTP REST API uses `/api/<resource>` — no version prefix like `/v1/`
  - ✅ Correct: `GET https://api-netbird.<domain>/api/accounts`
  - ❌ Wrong:   `GET https://api-netbird.<domain>/api/v1/accounts`
- **Why it matters:** `/api/v1/accounts` returns HTTP 404 silently; `/api/accounts` returns 401 for unauthenticated → correct behavior
- **Validation:** `curl -s -o /dev/null -w "%{http_code}" https://api-netbird.<domain>/api/accounts` → must return 401 (not 404)
- **Related:** `_check_netbird_token()` in `server.py`, Gatus health check config
- **Lesson learned:** Initial implementation used `/api/v1/accounts` based on incorrect docs assumption; corrected after live test showed 404 vs 401

## Auth Header

Personal Access Token (PAT) format: `nbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
Header: `Authorization: Token <PAT>`

Not `Bearer <PAT>` — must use `Token` prefix for NetBird PATs.
