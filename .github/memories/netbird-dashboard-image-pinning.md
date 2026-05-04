---
title: NetBird Dashboard Image — Version Pinning Required
description: netbirdio/dashboard:latest and v2.37.x are broken (supervisord crash). Pin to v2.36.0.
---

# NetBird Dashboard Image Pinning

## Memory

- **File path:** `kubernetes/platform/netbird/manifests/management.yaml`
- **Current pinned version:** `netbirdio/dashboard:v2.36.0`

## Decision

`netbirdio/dashboard:latest` and `v2.37.0`, `v2.37.1` all crash with:
```
Error: bad marshal data (unknown type code)
For help, use /usr/bin/supervisord -h
exit code 2
```

All three share the same 47MB image digest — `latest` == `v2.37.1`.

**Root cause:** supervisord Python marshal incompatibility in the v2.37.x build. The container exits immediately before any useful log output.

## Fix Applied (April 2026 + re-pinned May 2026)

Pinned to `v2.36.0` (released March 25, 2026) — last known good version.

**NOTE (May 2026):** The file was inadvertently updated to `v2.37.1` (probably during a dependency scan or image update PR). This caused the CSS 404 symptom: the container crashed, nginx never started, the main page HTML was served from Cloudflare cache (200) but CSS assets bypassed cache and hit the dead container (404). Re-pinned to `v2.36.0` in commit `a630bb4`.

## Why it Matters

- `imagePullPolicy: Always` means every pod restart pulls a new image
- `latest` tag silently picks up broken releases
- All netbird services (management, signal, relay) should be pinned to avoid this

## Before Upgrading to v2.37.x+

Test by running a temporary pod:
```bash
kubectl run nb-dash-test --image=netbirdio/dashboard:v2.37.1 \
  --restart=Never -n netbird \
  --env="USE_AUTH0=false" \
  --env="AUTH_AUTHORITY=https://auth.rlservers.com/application/o/netbird/" \
  --env="AUTH_CLIENT_ID=netbird" \
  --env="AUTH_AUDIENCE=netbird" \
  --env="NETBIRD_MGMT_API_ENDPOINT=https://netbird.rlservers.com" \
  --env="NETBIRD_MGMT_GRPC_API_ENDPOINT=https://netbird.rlservers.com" \
  --env="AUTH_SUPPORTED_SCOPES=openid profile email offline_access api"

kubectl logs nb-dash-test -n netbird
kubectl delete pod nb-dash-test -n netbird
```

Only upgrade if the test pod runs without the supervisord crash.
