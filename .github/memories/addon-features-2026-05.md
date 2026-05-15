---
title: New addon features - May 2026
description: New pages added to InfraWeaver console
---

## Prioritized operator features

Implemented the highest daily-ops value items with the best value/effort ratio:
- `/events` — cluster-wide Kubernetes event feed with namespace/type filters, search, warning emphasis, and acknowledgement workflow.
- `/certificates` — cert-manager certificate inventory with issuer, secret, expiry, renewal timing, and fallback TLS secret parsing.
- `/cronjobs` — cluster CronJobs with next-run prediction, recent job history, last success/failure visibility, and one-click manual trigger.
- `/ingress` — Traefik IngressRoute audit page showing hosts, auth middlewares, backend services, entrypoints, and TLS details.
- Notification bell improvements — unread warning/error notifications now come from cluster events instead of an empty placeholder route.

## API work

Added or upgraded real-data routes with mock fallback:
- `src/app/api/cluster/events/route.ts`
- `src/app/api/security/certs/route.ts`
- `src/app/api/cluster/cronjobs/route.ts`
- `src/app/api/ingress/route.ts`
- `src/app/api/notifications/route.ts`

Compatibility aliases were added for direct feature routes:
- `/api/certificates`
- `/api/cronjobs`
- `/api/events`

## Shared infrastructure added

- `src/lib/ops-data.ts` centralizes event, certificate, cronjob, and ingress loaders.
- `src/lib/cron-utils.ts` computes upcoming CronJob runs from standard 5-field cron expressions.
- `src/lib/event-ack.ts` persists acknowledged event IDs so the events page and topbar bell stay in sync.

## UI/navigation updates

- Added `/ingress` to the shared nav config and RBAC route map.
- Updated breadcrumb labels for the new ingress page.
- Upgraded notification center UI to show live warning/error counts.

## Validation

- `npx eslint` on all changed console files passed.
- `npm test -- --runInBand --passWithNoTests` passed (4 suites, 14 tests).
- `npm run build` could not run in this environment because installed Node is `18.19.1` while Next.js requires `>=20.9.0`.
