---
title: Enterprise Stability 2026-05
description: Complete stability and resilience hardening of InfraWeaver platform
---
# Enterprise Stability

## Memory
- **ErrorBoundary**: `components/error-boundary.tsx` wraps all dashboard pages via layout.tsx `<ErrorBoundary>` around `{children}`
- **Global error.tsx**: `app/error.tsx` shows friendly UI with requestId + reports to `/api/errors`
- **Error API**: `app/api/errors/route.ts` — accepts POST, writes structured JSON to stdout
- **Circuit breaker**: `lib/circuit-breaker.ts` — CLOSED/OPEN/HALF_OPEN, 5 failures/60s opens, 30s cooldown; instances for argocd, prometheus, authentik, longhorn, gatus
- **React Query**: `lib/query-client.ts` factory with exponential retry (skip 4xx), 30s staleTime, 5min gcTime, mutations retry:1
- **fetchWithTimeout**: `lib/fetch-with-timeout.ts` — AbortController wrapper, default 10s timeout
- **api-cache**: `lib/api-cache.ts` has `withCacheControl()` helper for `s-maxage=30, stale-while-revalidate=60`
- **Probes**: console deployment has startupProbe (failureThreshold:30, periodSeconds:10) + liveness/readiness; API already had probes
- **PDB**: both console and API have `minAvailable:1` PodDisruptionBudget
- **Structured logging**: `middleware/logger.ts` — `{ timestamp, level, requestId, method, path, status, durationMs, userId, clusterId, clientIp }`
- **requestId middleware**: set in `index.ts` before requestLogger; uses `x-request-id` header or generates `req_<ts>_<random>`
- **Response time ring buffer**: `lib/response-time.ts` — 100-slot ring buffer, p95 computation, fed by requestLogger
- **Prometheus metrics**: `lib/prom-metrics.ts` + `routes/prometheus.ts` — `GET /metrics` in Prometheus text format (counters + histograms)
- **Health endpoint**: `routes/health.ts` — checks argocd reachability + k8s API, reports p95 from ring buffer
- **Graceful shutdown**: SIGTERM/SIGINT in `index.ts` — drains up to 30s then exits 0
- **Unhandled rejections**: `unhandledRejection` + `uncaughtException` handlers in `index.ts`
- **Prometheus alerts**: `kubernetes/monitoring/alerts/console-availability.yaml` — pod count, P95 latency, error rate
- **ArgoCD**: both Application manifests have syncPolicy.retry (limit:5, backoff 5s→2x→3m) + ignoreDifferences for Deployment/ReplicaSet replicas
- **Bundle analyzer**: `@next/bundle-analyzer` in devDeps + `scripts/analyze.sh`
