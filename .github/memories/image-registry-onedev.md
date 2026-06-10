# Image Registry Migration: ghcr.io → onedev.example.com

## Current state (as of 2026-05-26)
All InfraWeaver application images have been migrated from GitHub Container Registry (`ghcr.io`) to the internal OneDev registry (`onedev.example.com`).

## The only pull secret needed is `onedev-pull-secret`
- `ghcr-pull-secret` has been **removed** from all namespaces and deployment manifests
- Using `ghcr-pull-secret` in `imagePullSecrets` causes `ImagePullBackOff` immediately
- `onedev-pull-secret` is the sole pull secret; it is auto-created by OneDev's namespace setup

## Affected namespaces
- `infraweaver-console` — uses `onedev-pull-secret` only
- `infraweaver-api` — uses `onedev-pull-secret` only

## Image name format
```
onedev.example.com/<project>/<image>:<tag>
# Example:
onedev.example.com/infraweaver/console:main-abc1234
```

## When deploying new apps that use OneDev images
1. Add only `onedev-pull-secret` to `imagePullSecrets`
2. Do NOT add `ghcr-pull-secret` — it does not exist and will cause ImagePullBackOff
3. The secret is created automatically when OneDev provisions the namespace

## When deploying apps from external registries (Docker Hub, quay.io, etc.)
No pull secret is needed for public images. For private external registries, create a new named secret — never reuse `onedev-pull-secret` for non-OneDev registries.
