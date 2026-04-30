---
title: Let's Encrypt Rate Limit Patterns & Fixes
description: Patterns for hitting rate limits during repeated redeployments and how to bypass them.
---

# Let's Encrypt Rate Limit Patterns

## The Problem

Let's Encrypt enforces **5 certificates per 168h per exact set of identifiers**.  
Multiple full redeployments on the same day hit this limit quickly for any cert that gets re-issued each deploy.

## Certificates We Manage

| Certificate | SANs | Issuer | Rate Limit Risk |
|-------------|------|--------|-----------------|
| `rlservers-com-wildcard` | 9 public domains | HTTP-01 | Medium (infrequent change) |
| `netbird-rlservers-com` | `netbird.rlservers.com` only | HTTP-01 | Low (separate) |
| `int-rlservers-com-wildcard` | `*.int.rlservers.com` | DNS-01 (Cloudflare) | **HIGH** (fresh deploy = new issue) |
| `.nl` certs | per-domain | DNS-01 / HTTP-01 | Medium |

## Rate Limit Bypass: Change the SAN Set

When a cert hits rate limits for its exact identifier set, add/remove a domain to create a **new exact set**:

### Rules
1. Cannot add a subdomain that is already covered by a wildcard in the same cert  
   → `home.int.rlservers.com` + `*.int.rlservers.com` = 400 "redundant wildcard" error
2. Can add/remove the apex domain  
   → `{int.rlservers.com, *.int.rlservers.com}` vs `{*.int.rlservers.com}` = different sets ✅
3. Can add a completely new domain (e.g., another subdomain not covered by wildcard)

### `int-rlservers-com-wildcard` pattern (April 2026)

Previous 5 certs used `[int.rlservers.com, *.int.rlservers.com]`.  
Fix: use ONLY `[*.int.rlservers.com]` — apex is not needed for routing, wildcard covers all subdomains.

```yaml
# kubernetes/apps/external-routes/manifests/02-certificates.yaml
spec:
  dnsNames:
    - "*.int.rlservers.com"   # just the wildcard — apex removed to create new SAN set
```

### `auth-rlservers-com` pattern (April 2026)

`auth-rlservers-com` individual cert hit 5 cert limit.  
Fix: merge `auth.rlservers.com` into `rlservers-com-wildcard` bundle (new 9-SAN set never previously rate-limited).

```yaml
# Add auth.rlservers.com to rlservers-com-wildcard dnsNames
# Remove the separate auth-rlservers-com Certificate resource
# Update 11-routes-authentik.yaml tls.secretName → rlservers-com-wildcard-tls
```

## DNS Entry Required for Cluster-Internal Certs

Any domain in a cert that is also used from inside the cluster (e.g., by NetBird clients) **must** be in CoreDNS custom zones:

```
# kubernetes/apps/dns/manifests/configmap.yaml → rlservers.com.hosts
10.10.0.200  netbird.rlservers.com  # ← NetBird clients resolve this from inside cluster
10.10.0.200  auth.rlservers.com    # ← Authentik OIDC endpoint for NetBird management
```

Missing DNS entries cause `server misbehaving` in pod logs → clients crash loop.

## ArgoCD + Live kubectl apply

When applying cert changes directly to the cluster via `kubectl apply`:
- **Always push to git FIRST** — ArgoCD will re-sync and overwrite your live changes within seconds
- Or: disable ArgoCD auto-sync on the app before patching, then push git and re-enable

## `.nl` Rate Limits (WordPress sites)

Cloudflare-proxied `.nl` domains use DNS-01. Rate limits hit if Cloudflare API token lacks DNS:Edit.  
After fixing token, auto-retry happens automatically via cert-manager backoff.  
**Do not manually force retry** — cert-manager exponential backoff will handle it.

## Checking Rate Limit Retry Time

```bash
kubectl describe certificate <name> -n traefik | grep "retry after"
# Output: retry after 2026-05-01 16:14:16 UTC
```

## Verification After Fix

```bash
# Confirm new SAN set is being ordered (not hitting rate limit)
kubectl get certificaterequests -n traefik  # READY column: should flip to True

# Confirm cert secret SANs
kubectl get secret <tls-secret-name> -n traefik \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -text | grep -A1 "Subject Alt"
```
