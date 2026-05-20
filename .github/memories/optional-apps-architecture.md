---
title: Optional vs required app architecture
description: How to enable/disable optional platform apps and what's truly required
---

# Optional Apps Architecture

## Memory

- **File paths:**
  - `platform.yaml` — source of truth for enabled/disabled state
  - `kubernetes/bootstrap/app-*.yaml` — standalone ArgoCD Application files
  - `kubernetes/bootstrap/app-*.yaml.disabled` — disabled standalone apps (skipped by deploy glob)
  - `scripts/sync-groups.sh` — manages AppSet files AND companion bootstrap files

- **Decision:** Split apps into true core (always deploy) vs optional (disabled by default, opt-in)

## True Core (always deploy)

**kubernetes/core/:** argocd, cert-manager, traefik, external-secrets, longhorn, openbao, metallb, kyverno, priority-classes, metrics-server, etcd-maintenance, limitranges, csi-driver-smb

**kubernetes/platform/ required:** authentik, authentik-ldap-outpost, dns, external-routes

**Always-on bootstrap files:** app-argocd-manifests.yaml, app-authentik-manifests.yaml, app-authentik-ldap.yaml, app-dns.yaml, app-external-routes.yaml, app-traefik-manifests.yaml, app-longhorn-manifests.yaml

## Optional Components (disabled by default)

| Component | platform.yaml key | Companion bootstrap file(s) |
|---|---|---|
| Monitoring stack | groups.core-monitoring.enabled: true | app-alertmanager-discord.yaml, app-monitoring-*.yaml |
| NetBird VPN | groups.core-platform.apps.netbird.enabled: true | app-netbird.yaml |
| Velero backups | groups.core-platform.apps.velero.enabled: true | app-velero.yaml |
| MinIO for Velero | groups.core-platform.apps.minio-velero.enabled: true | app-minio-velero.yaml |
| External DNS | groups.core-platform.apps.external-dns.enabled: true | app-external-dns-helm.yaml, app-external-dns-manifests.yaml |
| ArgoCD Image Updater | groups.core-platform.apps.argocd-image-updater.enabled: true | app-argocd-image-updater.yaml |
| Standalone Grafana | groups.core-platform.apps.grafana.enabled: true | app-grafana-manifests.yaml |
| Falco security | groups.core-platform.apps.falco.enabled: true | app-falco-manifests.yaml |
| Wazuh SIEM | groups.core-platform.apps.wazuh.enabled: true | (none) |

## How to Enable an Optional Component

1. Edit `platform.yaml` — set `enabled: true` for the group or app
2. Run `scripts/sync-groups.sh` — this restores companion bootstrap files AND updates AppSet files
3. Commit + push — ArgoCD picks up changes on next sync
4. On fresh deploys: `deploy-argocd.sh` applies `kubernetes/bootstrap/*.yaml` (skips `.disabled`)

## How sync-groups.sh Manages Companions

- COMPANIONS map in the Python block maps `"group_name"` and `"group_name.app_name"` to lists of companion bootstrap filenames
- `manage_companions(key, enabled)`: renames `app-X.yaml` → `app-X.yaml.disabled` when disabled, and `app-X.yaml.disabled` → `app-X.yaml` when re-enabled
- Both AppSet-managed apps (those with application.yaml in tier dir) AND standalone bootstrap apps (no application.yaml) are handled correctly

## Why it matters

- Fresh deploys without this: ~2GB extra RAM from monitoring + many services failing (external-dns needs Cloudflare token, netbird needs setup, etc.)
- Optional apps that need prerequisites (Cloudflare token, NAS config, VPN setup) no longer fail fresh deployments
- Console gracefully degrades: prometheus/loki features hidden when monitoring is disabled

## Lesson learned

Two types of ArgoCD Application management:
1. **AppSet-managed**: app has `application.yaml` in its tier dir → AppSet discovers it → disable by renaming to `.disabled`
2. **Standalone bootstrap**: app has `app-X.yaml` in `kubernetes/bootstrap/` → applied once by deploy-argocd.sh → disable by renaming to `.disabled`

The deploy-argocd.sh glob `kubernetes/bootstrap/*.yaml` naturally skips `.disabled` files — no script changes needed for the deploy step.
