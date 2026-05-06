# kubernetes/catalog/ — Optional App Library

This directory contains **catalog apps** — applications that are supported by the platform
but not always deployed. They are enabled or disabled via `platform.yaml` at the repo root.

## How It Works

```
platform.yaml           ← Edit this to enable/disable apps
    ↓ (CI reads)
scripts/sync-catalog.sh ← Generates/removes ArgoCD Application bootstrap files
    ↓
kubernetes/bootstrap/   ← catalog-<app>.yaml files (auto-generated)
    ↓
ArgoCD                  ← Deploys/removes the app
```

## Adding a New Catalog App

1. Create `kubernetes/catalog/<app-name>/` using the `_template/` as a reference
2. Add a `catalog.yaml` with source metadata (not `application.yaml` — that would be auto-discovered)
3. Add your Helm values in `values.yaml` (if Helm chart)
4. Add raw manifests in `manifests/` (Namespace, NetworkPolicy, ExternalSecret, etc.)
5. Add your app name to `platform.yaml` under `catalog.enabled`
6. Push — CI generates the bootstrap files and ArgoCD deploys

## Removing an App

1. Remove the app name from `platform.yaml`
2. Push — CI removes the bootstrap files
3. ArgoCD (with `resources-finalizer`) deletes all app resources

## Directory Structure

```
catalog/
├── README.md
├── _template/          ← Template for new apps (copy this)
│   ├── catalog.yaml    ← Source definition (Helm chart or raw manifests)
│   ├── values.yaml     ← Helm values (optional)
│   └── manifests/      ← Raw K8s resources
│       ├── namespace.yaml
│       ├── networkpolicy.yaml
│       └── ...
├── wiki/               ← Wiki.js (wiki.int.rlservers.com)
│   ├── catalog.yaml
│   ├── values.yaml
│   └── manifests/
└── <your-app>/
```

## Catalog App List

| App | Description | URL |
|-----|-------------|-----|
| wiki | Wiki.js documentation wiki | wiki.int.rlservers.com |

See `platform.yaml` at repo root for the currently enabled apps.
