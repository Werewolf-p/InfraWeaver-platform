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
| `rlservers-com-wildcard` | 10 public domains (incl. auth + netbird) | HTTP-01 | Low (big bundle, infrequent change) |
| `int-rlservers-com-wildcard` | `*.int.rlservers.com` | DNS-01 (Cloudflare) | **HIGH** (fresh deploy = new issue) |
| `.nl` certs | per-domain | DNS-01 / HTTP-01 | Medium |

> **Design principle:** Bundle all public domains into `rlservers-com-wildcard`. No individual certs.
> Individual certs (previously `auth-rlservers-com`, `netbird-rlservers-com`) hit 5/168h rate limits
> during multiple same-day redeployments. The bundle is one large SAN set — each new domain added
> creates a new exact set with a fresh 5-cert allowance.

## Primary Fix: Backup & Restore TLS Secrets Across Redeployments

The real solution to avoid rate limits is to **backup TLS secrets before destroy** and **restore after deploy**.
This way cert-manager never needs to re-issue certificates on redeployments.

### Workflow Steps (full-redeploy.yml)

1. **`Backup TLS secrets before destroy`** (before `Destroy existing platform`):
   - Saves `rlservers-com-wildcard-tls` and `int-rlservers-com-tls` from `traefik` namespace
   - Uses variable capture (`YAML=$(kubectl ...)`) then checks `${#YAML} -gt 100` before writing
   - Uses `--insecure-skip-tls-verify` because old kubeconfig CA may be stale after full destroy
   - Location: `/opt/platform-tls-backup/`

2. **`Bootstrap ExternalSecrets + TLS Restore`** (after ArgoCD deploys Traefik):
   - Waits for `traefik` namespace to exist
   - Applies backup files via `kubectl apply`, stripping `resourceVersion/uid/creationTimestamp`
   - If backup is empty/missing, cert-manager issues fresh certs (rate limit risk)

3. **`Refresh TLS secret backup`** (after post-deploy tests succeed):
   - Waits for both `rlservers-com-wildcard` AND `int-rlservers-com-wildcard` to be ready
   - Skips certs with `reason=Failed` (rate-limited) to avoid overwriting good backup with empty
   - Updates backup files for next redeploy

### Critical: What Broke the Backup

The backup shell redirect pattern `kubectl get secret ... > file` **creates an empty file even if kubectl fails**
because the redirect truncates the file before kubectl runs. Fix: capture to variable first.

```bash
# WRONG — creates empty file on kubectl failure:
kubectl get secret foo -o yaml > /backup/foo.yaml

# CORRECT — only writes if kubectl succeeds and returns data:
YAML=$(kubectl get secret foo -o yaml 2>/dev/null || echo "")
if [ ${#YAML} -gt 100 ]; then echo "$YAML" > /backup/foo.yaml; fi
```

### Critical: Never Backup Self-Signed Certs

When LE is rate-limited, a self-signed cert ends up in the TLS secret. The backup step must check the issuer
before saving — otherwise the self-signed cert gets restored on the next redeploy, causing `ERR_CERT_AUTHORITY_INVALID`.

```bash
# Check issuer before backing up
CERT_ISSUER=$(echo "$YAML" | python3 -c "
import sys, base64, subprocess, re
data = sys.stdin.read()
m = re.search(r'tls\.crt: ([A-Za-z0-9+/=]+)', data)
if m:
    crt = base64.b64decode(m.group(1))
    r = subprocess.run(['openssl','x509','-noout','-issuer'], input=crt, capture_output=True)
    print(r.stdout.decode().strip())
" 2>/dev/null || echo "unknown")
if echo "$CERT_ISSUER" | grep -qi "Let's Encrypt\|letsencrypt\|ISRG"; then
    echo "$YAML" > "$BACKUP_DIR/${secret}.yaml"
fi
```

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

**Update (May 2026):** `[*.int.rlservers.com]` alone hit 5/168h limit. Fix: add apex back → `[int.rlservers.com, *.int.rlservers.com]`. This is now the canonical SAN set (see `02-certificates.yaml`). The apex is intentionally kept — it creates a distinct identifier set from the wildcard-only set.

```yaml
# kubernetes/platform/external-routes/manifests/02-certificates.yaml
spec:
  dnsNames:
    - "int.rlservers.com"     # apex intentionally included — forms distinct SAN set
    - "*.int.rlservers.com"   # wildcard covers all *.int.rlservers.com subdomains
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
# kubernetes/platform/dns/manifests/configmap.yaml → rlservers.com.hosts
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
