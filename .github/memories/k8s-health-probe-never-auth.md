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
