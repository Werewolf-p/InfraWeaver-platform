---
title: k8s liveness/readiness probe endpoint must never require authentication
description: /api/health is used as the k8s liveness and readiness probe — adding auth causes CrashLoopBackOff
---

# k8s Probe Endpoint Must Be Public

## Memory

- **File paths:**
  - `apps/infraweaver-console/src/app/api/health/route.ts` — public (probe endpoint)
  - `apps/infraweaver-console/src/app/api/health/timeline/route.ts` — protected (mock data)
  - `apps/infraweaver-console/src/app/api/platform/status/route.ts` — protected (infra info)
  - `kubernetes/catalog/infraweaver-console/manifests/deployment.yaml` — defines probe paths

- **Decision:** `/api/health` MUST remain unauthenticated. The k8s liveness and readiness probes (defined in deployment.yaml) call this endpoint from inside the cluster. If auth is required, the probe gets a 401 → pod is killed → CrashLoopBackOff.

- **Why it matters:** Adding `getServerSession` / `auth()` to `/api/health` causes all new pods to fail health checks immediately. Old pods keep running (rolling deploy), so the site stays up on the old image — but the new image can never roll out.

- **Validation:**
  ```bash
  kubectl describe pod -n infraweaver-console <pod> | grep "Liveness\|Readiness"
  # Liveness: http-get http://:3000/api/health
  # Readiness: http-get http://:3000/api/health
  kubectl get pods -n infraweaver-console  # should show Running, not CrashLoopBackOff
  ```

- **Related:** `kubernetes/catalog/infraweaver-console/manifests/deployment.yaml` lines ~45-55 define the probe paths. If probe paths change, update this memory.

- **Lesson learned:** When adding authentication to API routes for security hardening, always check: is this route used as a k8s probe endpoint? Health/ping/status endpoints at the "liveness" level must stay public. Sensitive data should live on *separate* authenticated routes.

## Update — 2026-05-16: /api/health must not be used as liveness probe

**Lesson learned:** `/api/health` returns HTTP 503 when Gatus is unreachable (correct for monitoring).
Pointing k8s liveness/readiness probes + CI smoke test at `/api/health` caused:
- k8s to restart console pods whenever Gatus was down
- Every CI deploy to fail its smoke test and roll back

**Fix:** Use `/api/ping` for all infrastructure-level checks:
- `deployment.yaml` livenessProbe + readinessProbe → `/api/ping`
- CI smoke test `SMOKE_URL` → `https://infraweaver.int.rlservers.com/api/ping`

**Rule:** `/api/ping` = "is the process alive?" (no external deps, always 200).
         `/api/health` = "are monitoring endpoints healthy?" (may 503).

## Update 2 — 2026-05-16: Full root cause chain documented

Three separate issues all needed fixing together:

### 1. /api/health → /api/ping for ALL probes (startupProbe too!)
- All three probes must use /api/ping: startupProbe, readinessProbe, livenessProbe
- Missing startupProbe fix means pods never pass startup → never become Ready

### 2. Next.js edge runtime cannot use node:crypto
- middleware.ts runs in edge runtime — no Node.js built-ins allowed
- Fix: replace `import { randomUUID } from "node:crypto"` with `crypto.randomUUID()` (Web Crypto API, global in edge runtime)
- Fix: replace `Buffer.from(uuid, "hex").toString("base64url")` with btoa + Uint8Array (no Buffer in edge runtime)
- Symptom: pod starts ("✓ Ready in 0ms") but all requests return 500

### 3. ArgoCD sync timeout too short for fresh image pulls
- Registry (onedev.rlservers.com) can be slow; fresh image pulls take 3-4+ minutes
- Default SYNC_TIMEOUT_SECONDS=300 and progressDeadlineSeconds=300 → race condition
- Fix: both set to 600 seconds

### Rule for middleware.ts (edge runtime only):
- ✅ crypto.randomUUID(), crypto.getRandomValues() — Web Crypto globals
- ✅ btoa(), atob(), TextEncoder, TextDecoder, fetch, URL
- ❌ node:crypto, node:fs, node:path, Buffer, process.env (except via Next.js)
- ❌ Any Node.js built-in module (use Web API equivalents)
