---
title: IaC Comprehensive Improvement Rollout — May 2026
description: Summary of all IaC best-practice improvements applied across 4 commits
---

# IaC Comprehensive Improvement Rollout

## Memory

- **Commits:** a6ef702, e29441b, cf5d1e2, 360b181 + follow-on
- **Date:** 2026-05-03
- **Decision:** Systematic IaC hardening based on 7-source best-practices audit

## What Was Changed

### Commit a6ef702 — P1 Security Fixes
- Pinned NetBird management/signal/relay to `v0.70.4` (was `:latest`)
- Pinned busybox init containers to `1.36` (was `:latest`)
- Fixed Grafana node affinity: replaced hardcoded `talos-prod-cp1` hostname with `grafana-eligible=true` label
- Added `grafana-eligible=true` label to cp2/cp3 in both `apply-changes.yml` and `full-redeploy.yml`
- Set `deploy_platform_bootstrap=true` in productie terraform.tfvars
- Pinned example-app nginx chart from `11.*` to `11.3.6`
- Removed `openbao.rlservers.com` public ingress — replaced with `openbao.int.rlservers.com`
- Removed `kubernetes/**` trigger from `platform.yml` (ArgoCD handles K8s manifests)
- Fixed `talos-upgrade-extensions.yml`: use `envs/productie/generated/talosconfig` instead of hardcoded `/home/ubuntu/...` path
- Replaced deprecated `kubeval` with `kubeconform v0.7.0` in security-scan
- Added `actionlint v1.7.12` to security-scan
- Added `trivy v0.70.0` image scanning (CRITICAL CVEs, soft-fail) to security-scan

### Commit e29441b — P2 Reliability
- Added PodDisruptionBudgets for Traefik, cert-manager, and Authentik
- Added platform PrometheusRules: node health, storage, pod, etcd, TLS cert expiry
- Configured Alertmanager with email routing to remonhulst@gmail.com
- Created `monitoring-alerts` ArgoCD Application for PrometheusRule manifests
- Set ApplicationSet `prune: false` (prevents accidental resource deletion on sync)
- Added `.github/dependabot.yml` for weekly GitHub Actions + Terraform provider updates
- Pinned `bridgecrewio/checkov-action` to commit SHA

### Commit cf5d1e2 — P3/P4 DX Tools
- Fixed trivy install: direct binary (v0.70.0)
- Fixed actionlint install: direct binary (v1.7.12)
- Updated kubeconform to v0.7.0
- Added `.pre-commit-config.yaml` (tofu fmt, yamllint, gitleaks, hygiene hooks)
- Added `.yamllint.yaml` configuration
- Added `.tool-versions` (opentofu 1.11.6, kubectl 1.32.4, talosctl 1.9.0, etc.)
- Added `CONTRIBUTING.md` with complete platform onboarding guide
- Integrated `test-post-deploy.sh` into `apply-changes.yml` post-health-check (non-blocking)

### Commit 360b181 — P3 CI/CD
- Made `deploy` job depend on `plan` in `platform.yml` (`needs: [plan]`)
- Added `drift-detection.yml`: weekly scheduled `tofu plan` with artifact upload

### Follow-on commit — P2 Security/Storage
- Added OpenBao audit logging to `values.yaml` (file audit device)
- Added NetworkPolicies for traefik and openbao namespaces
- Added `etcd-snapshot.yml`: weekly etcd snapshot workflow
- Added `openbao-snapshot.yml`: weekly OpenBao Raft snapshot workflow

## Important Patterns

### Grafana node labelling
```bash
# Must be run once after cluster bootstrap (included in apply-changes.yml)
kubectl label node talos-prod-cp2 grafana-eligible=true
kubectl label node talos-prod-cp3 grafana-eligible=true
```

### ArgoCD app names (reminder)
- `apps-authentik-manifests` (not `authentik`)
- Pattern: `<tier>-<appname>-manifests` for manifest-only apps
- Pattern: `<tier>-<appname>` for Helm apps from ApplicationSet

### Dependabot
- Runs weekly Monday 09:00 UTC
- Creates PRs for outdated GitHub Actions and Terraform providers
- Review and merge manually — do NOT auto-merge infrastructure changes

### Snapshot schedule
- etcd snapshot: every Sunday 03:00 UTC
- OpenBao snapshot: every Sunday 04:00 UTC
- Artifacts retained 28 days (4 weeks)

## Why It Matters
- `:latest` images are unpredictable — pinning ensures reproducible deploys
- `prune: true` in ArgoCD can delete resources accidentally during chart upgrades
- Audit logging is required for any security incident investigation
- PodDisruptionBudgets prevent total service outage during node drains
- Drift detection catches manual changes that bypass IaC

## Validation
- Security Scanning: passed ✅ (confirmed in CI run 25282379793)
- Dependabot: already creating PRs after first commit ✅
- PrometheusRules: deployed to `monitoring` namespace via ArgoCD
