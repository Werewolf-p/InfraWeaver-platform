# InfraWeaver Catalog Apps

Optional apps that can be installed on the platform by adding them to `catalog.enabled` in `platform.yaml`.

## Enabling / Disabling Apps

Edit `platform.yaml`:

```yaml
catalog:
  enabled:
    - wiki
    - uptime-kuma
    - it-tools    # add to enable
```

Then push to main — ArgoCD will auto-deploy or remove the app.

---

## Available Apps

| App | URL | Auth | Storage | Description |
|-----|-----|------|---------|-------------|
| `wiki` | wiki.int.rlservers.com | Authentik OIDC | 5Gi | Wiki.js documentation wiki |
| `uptime-kuma` | uptime-kuma.int.rlservers.com | Forward-auth | 1Gi | Status/uptime monitoring |
| `gitea` | gitea.int.rlservers.com | Native OIDC | 5Gi PG | Self-hosted Git forge |
| `vaultwarden` | vaultwarden.int.rlservers.com | Forward-auth | 1Gi | Bitwarden-compatible passwords |
| `it-tools` | it-tools.int.rlservers.com | Forward-auth | none | IT/Dev tool collection |
| `stirling-pdf` | stirling-pdf.int.rlservers.com | Forward-auth | none | PDF manipulation tools |
| `excalidraw` | excalidraw.int.rlservers.com | Forward-auth | none | Collaborative whiteboard |
| `actual` | actual.int.rlservers.com | Forward-auth | 2Gi | Personal finance / budgeting |
| `n8n` | n8n.int.rlservers.com | Forward-auth | 5Gi | Workflow automation |
| `forgejo` | forgejo.int.rlservers.com | Native OIDC | 10Gi PG | Community Git forge (Gitea fork) |

### Defined but not yet enabled

| App | URL | Auth | Description |
|-----|-----|------|-------------|
| `mealie` | mealie.int.rlservers.com | OIDC | Recipe manager |
| `changedetection` | changedetection.int.rlservers.com | Forward-auth | Website change monitor |
| `paperless-ngx` | paperless.int.rlservers.com | OIDC | Document management (complex) |

---

## Auth Patterns

### Forward-auth (simple apps)
Traefik sends every request to Authentik for authentication. No app-side config needed.
Users see the Authentik login page before reaching the app.

### Native OIDC (complex apps like Gitea, Forgejo)
The app handles OIDC itself. Authentik issues tokens directly to the app.
This allows features like org/team sync, SSH key management, etc.

---

## Adding a New Catalog App

1. Create `kubernetes/catalog/<app>/catalog.yaml`
2. Create `kubernetes/catalog/<app>/manifests/all.yaml` (or `resources.yaml` + Helm `values.yaml`)
3. For forward-auth apps: add Authentik proxy provider in `blueprint-apps.yaml`
4. Add app name to `platform.yaml` `catalog.enabled` list
5. Push to main — `sync-catalog.sh` runs automatically

See `docs/templates/app/` for the app template.
