---
title: infraweaver-node health server must start before discovery
description: Liveness probe kills the pod every ~75-160s if health server starts after discover()
---

# infraweaver-node: Start Health Server Before Discovery

## Memory

- **File paths:** `apps/infraweaver-node/src/index.ts`, `kubernetes/catalog/infraweaver-node/manifests/deployment.yaml`
- **Decision:** Health HTTP server must listen on port 3001 BEFORE calling `discover()` or `register()`, which block waiting for admin approval (up to 5 min timeout).
- **Why it matters:** The liveness probe (`/health`) fires at `initialDelaySeconds + failureThreshold × periodSeconds` seconds. With the old code order (health server started AFTER discover), the probe hit a closed port and killed the pod with SIGKILL (exit 137) on every attempt → infinite crash loop (88 restarts observed).
- **Validation:** Pod should survive past `initialDelaySeconds + failureThreshold × periodSeconds` seconds with 0 restarts. Previously killed at ~75s (3×30s+15s), then at ~160s (5×30s+10s) after probe tuning.
- **Pattern applied:** Use a mutable `appState = { connected: false, shuttingDown: false }` object read by the health handler closure. Update via `client.on('connected')` / `client.on('disconnected')` events. `/health` always returns 200 (process is alive); `/ready` returns 503 until `appState.connected`.
- **Discovery retry:** `discover()` has a 5-minute internal timeout. `withRetry` must treat timeout/websocket-close errors as retryable (`isDiscoveryRetryable`) but NOT admin rejection. Use `maxAttempts = Number.MAX_SAFE_INTEGER` for discovery since admin approval timing is unpredictable.
- **Lesson learned:** Any initialization that blocks indefinitely (waiting for external approval, admin action, etc.) must NOT gate the HTTP health server. Health servers should be the FIRST thing started.
