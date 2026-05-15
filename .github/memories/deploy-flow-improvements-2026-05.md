---
title: Deploy Flow Improvements — 2026-05
description: Rollback workflow, ArgoCD-forced deploy sync, Discord notifications, smoke tests, Trivy image scans, and zero-downtime rollout hardening.
---

# Deploy Flow Improvements

## Workflows
- Added `.github/workflows/rollback.yml` for one-click rollback of `infraweaver-console`, `infraweaver-api`, or `infraweaver-node` to a previous image tag.
- Build workflows now:
  - build and push the image
  - run a **blocking Trivy CRITICAL CVE scan** before updating GitOps manifests
  - update the deployment manifest with a `[skip ci]` commit
  - force an **ArgoCD hard-refresh + sync** and wait for Healthy/Synced
  - run a post-deploy smoke test for console/API
  - send Discord success/failure notifications when `DISCORD_WEBHOOK_URL` (or legacy `DISCORD_WEBHOOK`) is present
- `maintenance.yml` now accepts `DISCORD_WEBHOOK_URL` with fallback to the legacy secret name.

## Zero-downtime hardening
Updated these deployment manifests:
- `kubernetes/catalog/infraweaver-console/manifests/deployment.yaml`
- `kubernetes/catalog/infraweaver-api/manifests/deployment.yaml`
- `kubernetes/catalog/infraweaver-node/manifests/deployment.yaml`
- `kubernetes/platform/dns/manifests/deployment.yaml`
- `kubernetes/catalog/demo-catalog-app/manifests/deployment.yaml`
- `docs/templates/app/manifests/deployment.yaml`

Added/standardized:
- `revisionHistoryLimit`
- `progressDeadlineSeconds: 300`
- `minReadySeconds`
- explicit `RollingUpdate` strategy with `maxUnavailable: 0` / `maxSurge: 1` where applicable
- `terminationGracePeriodSeconds: 60`
- `preStop` sleep hooks to give kube-proxy/endpoints time to drain

## API availability
- Added `kubernetes/catalog/infraweaver-api/manifests/poddisruptionbudget.yaml` with `minAvailable: 1`.

## Node agent health checks
- `apps/infraweaver-node` now exposes:
  - `/health` → liveness
  - `/ready` → readiness (503 until Hub websocket is connected)
- Deployment now has HTTP readiness/liveness probes on port `3001`.

## Helper scripts
Added reusable deploy helpers:
- `scripts/deploy/sync-argocd-app.sh`
- `scripts/deploy/smoke-test-url.sh`
- `scripts/deploy/notify-discord.sh`

## Validation run
Validated in a clean worktree with:
- `actionlint -shellcheck=` on the changed workflows
- `shellcheck --severity=error` on the new deploy scripts
- `bash scripts/validate-platform-yaml.sh`
- `bash scripts/validate-users-yaml.sh`
- `apps/infraweaver-api`: `npm ci`, `npx tsc --noEmit`, `npm test -- --passWithNoTests`
- `apps/infraweaver-node`: `npm ci`, `npx tsc --noEmit`
- YAML parse checks for all changed workflow/manifests

## Known baseline issue
- `apps/infraweaver-console` TypeScript check still fails on pre-existing missing UI component imports; this was already failing before these deploy-flow changes and was not modified here.
