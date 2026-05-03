---
title: ak shell stdout pollution and kubectl exec -i stdin hang
description: Django ak shell writes JSON boot logs to stdout (polluting captured output), and kubectl exec -i does not reliably propagate stdin EOF causing indefinite hang
---

# Authentik ak shell — stdout pollution and kubectl exec -i hang

## Memory

- **File paths:**
  - `.github/workflows/full-redeploy.yml` — "Set Authentik admin privileges" step

- **Decision (bug 1 — stdout pollution):**  
  `kubectl exec -- ak shell -c "print('yes')"` captures both JSON boot logs AND the Python print output. Comparing `$()` result to `"yes"` always fails. Fix: pipe through `| tail -1` to get only the last printed line.

- **Decision (bug 2 — stdin hang):**  
  `echo code | kubectl exec -i -- ak shell` uses `kubectl exec -i` which keeps the stdin connection open even after the pipe source closes. Django shell never gets a clean EOF → waits forever. Fix: write Python to a temp file INSIDE the container first, then run with file redirection:
  ```bash
  echo "$CODE" | base64 -d | kubectl exec -i ... -- sh -c 'cat > /tmp/script.py'
  kubectl exec ... -- ak shell < /tmp/script.py
  ```
  File redirection (`< /tmp/script.py`) closes cleanly when file content is exhausted.

- **Why it matters:**
  - Bug 1 caused `_wait_for_user` to always iterate all 60 × 10s = 600s per user (10 min per user, even when users exist). Two users in parallel = ~10 min wasted on every deploy.
  - Bug 2 caused `ak shell` to hang indefinitely (no timeout) after the user wait completed. Step ran for 30+ minutes with no progress.

- **Validation:** After fix, the "Set Authentik admin privileges" step completes in ~2 minutes on the next full redeploy.

- **Related:** Users checked: `remon`, `ardaty` (from `users.yaml`). Groups set: `platform-admins`, `authentik Admins`, `platform-users`. API token created: `gh-actions-api-token`.

- **Lesson learned:** Never use bare `kubectl exec -i` with piped Python/stdin for multi-line scripts. Always write to a temp file inside the container first, then use file redirection to run it. For output comparison, use `| tail -1` to strip Django/ak shell boot messages from stdout.
