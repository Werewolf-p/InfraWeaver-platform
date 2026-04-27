---
title: Public Access via test.rlservers.com and Traefik Host Rewrite
description: How test.rlservers.com routes from external Traefik to K8s ingress via host header rewrite
---

# Public Test Website (test.rlservers.com)

## Architecture
```
Internet → 84.82.69.110 (Traefik at 10.25.0.5) → 10.25.0.200 (K8s MetalLB) → test-website pod
```

## Traefik Config (on 10.25.0.5)
File: `/home/remon/Traefik/dynamic/k8s-apps.yml`

**Critical**: This file must be in the ROOT of `/etc/traefik/dynamic/` (not in a subdirectory) for hot-reload to work.

```yaml
http:
  routers:
    test-website-https:
      rule: "Host(`test.rlservers.com`)"
      entryPoints: [websecure]
      service: k8s-test-website
      middlewares: [k8s-test-host]
      tls:
        certResolver: letsencrypt

    test-website-http:
      rule: "Host(`test.rlservers.com`)"
      entryPoints: [web]
      middlewares: [redirect-to-https]
      service: k8s-test-website

  middlewares:
    k8s-test-host:
      headers:
        customRequestHeaders:
          Host: "test.prod.local"   # Rewrite host so K8s ingress matches

  services:
    k8s-test-website:
      loadBalancer:
        servers:
          - url: "http://10.25.0.200"
        passHostHeader: true   # Must be true; middleware overrides the Host
```

**Key insight**: K8s ingress is configured with `host: test.prod.local`. The external hostname
`test.rlservers.com` won't match unless the Host header is rewritten. Use `customRequestHeaders`
middleware with `Host: "test.prod.local"` + `passHostHeader: true` (NOT false, which would send
the backend URL as host and compete with the middleware).

## DNS
- **Cloudflare**: `test.rlservers.com` A `84.82.69.110` (non-proxied, TTL 1 min)
- **K8s CoreDNS**: `test.prod.local` → `10.25.0.200` (for internal cluster access)
- **NetBird DNS**: `prod.local` domain → CoreDNS `10.96.0.10` (VPN clients use this)

## TLS Certificate
- Provider: Let's Encrypt via Traefik HTTP challenge
- Cert stored in: `/home/remon/Traefik/acme.json`
- Status: Issued ✅

## Access Control
- `test.rlservers.com` — Public, no middleware restrictions
- `grafana.prod.local`, `argocd.prod.local` etc — VPN only via `netbird-only` middleware

## Related
- `platform/kubernetes/apps/test-website/` — K8s test website deployment
- `platform/kubernetes/core/traefik/middleware-netbird.yaml` — IPAllowList for sensitive services
