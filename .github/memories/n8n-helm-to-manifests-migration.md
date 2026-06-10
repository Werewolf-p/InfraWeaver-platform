---
title: N8N migrated from broken charts.n8n.io helm to git manifests
description: charts.n8n.io has no DNS A record; N8N now managed via raw Kubernetes manifests in git
---

# N8N Helm to Git Manifests Migration

## Memory

- **File paths:**
  - `kubernetes/platform/n8n/manifests/` — raw K8s manifests (deployments, services, ingress, namespace)
  - `kubernetes/bootstrap/app-n8n-manifests.yaml` — static ArgoCD Application (git path source)
  - `kubernetes/platform/n8n/application.yaml` — DELETED (was broken helm chart reference)

- **Decision:** Switched from `repoURL: https://charts.n8n.io/` helm chart (no DNS A record → ArgoCD Unknown sync) to static raw manifests managed via git. ArgoCD Application uses `source.path: kubernetes/platform/n8n/manifests` instead of helm chart source.

- **Why it matters:** The platform ApplicationSet at `kubernetes/bootstrap/appset-core-platform.yaml` is helm-only (uses `sources[].chart`). Static apps in `kubernetes/bootstrap/` bypass the ApplicationSet and use a git-path source. When `application.yaml` is absent, the ApplicationSet stops managing that app.

- **To update N8N version:** Edit `kubernetes/platform/n8n/manifests/n8n-deployment.yaml`, bump `spec.template.spec.containers[0].image` tag (e.g. `n8nio/n8n:1.62.0`), commit and push. ArgoCD selfHeal will apply it.

- **N8N architecture:**
  - Deployment: `n8n` (app image, connects to PostgreSQL)
  - Deployment: `postgresql-n8n` (dedicated Postgres)
  - Services: `n8n` (headless), `n8n-api` (ClusterIP, port 8080), `n8n-http` (LoadBalancer, port 8080→5678)
  - Ingress: `n8n-ingress` → `n8n.example.com` via Traefik

- **Lesson learned:** charts.n8n.io disappeared (no A record in Cloudflare DNS). When a helm chart repo breaks, converting to git-managed manifests is the most stable long-term fix and removes external chart dependencies entirely.
