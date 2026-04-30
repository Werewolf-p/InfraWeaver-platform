---
title: NetBird Architecture — Kubernetes deployment on VLAN3
description: NetBird runs entirely in Kubernetes (VLAN3), accessed via Cloudflare proxy, with Authentik PKCE SSO.
---

# NetBird Architecture (Current — April 2026)

## Deployment

NetBird runs fully in Kubernetes (`netbird` namespace) on the VLAN3 cluster (10.10.0.0/24).  
**Old VM-based deployment at 10.25.0.100 is decommissioned.**

## MetalLB VIPs (Internal)

| VIP | Service | Port |
|-----|---------|------|
| 10.10.0.202 | netbird-management-lb | 80, 33073 |
| 10.10.0.203 | netbird-signal-lb | 10000 |
| 10.10.0.204 | netbird-relay | 443 |

## External Access (via Cloudflare → Traefik)

**Domain:** `netbird.rlservers.com` → Cloudflare (proxied) → 84.82.69.110 → Traefik (10.10.0.200)

| Path | Backend Service | Port | Scheme |
|------|----------------|------|--------|
| `/management.ManagementService/*` | netbird-management-grpc | 33073 | h2c |
| `/management.ProxyService/*` | netbird-management-grpc | 33073 | h2c |
| `/signalexchange.SignalExchange/*` | netbird-signal | 10000 | h2c |
| `/relay` | netbird-relay | 443 | http (WebSocket) |
| `/api/*` | netbird-management | 80 | http |
| `/*` | netbird-dashboard | 80 | http |

**IngressRoute file:** `kubernetes/apps/external-routes/manifests/09-routes-netbird.yaml`  
**TLS cert:** `netbird-rlservers-com-tls` (individual cert, DNS-01/Cloudflare, never rate-limited)

## Cloudflare Requirements

- **SSL mode: Full** (NOT Flexible — Flexible causes 308 redirect → gRPC breaks)
- **HTTP/2: ON** (required for gRPC)
- `origin_max_http_version: 2` — CF connects to origin over HTTP/2
- gRPC works on Free plan with these settings (the `grpc` toggle returns 9109 but doesn't matter)

## management.json Key Settings

Location: `/var/lib/netbird/management.json` on PVC (`netbird-management-data`)  
Template: `kubernetes/apps/netbird/manifests/management.yaml` (ConfigMap)  
**The PVC copy is authoritative after first boot — template changes require PVC file deletion.**

```json
{
  "HttpConfig": {
    "AuthAudience": "netbird",
    "AuthUserIDClaim": "",
    "IdpSignKeyRefreshEnabled": true,
    "OIDCConfigEndpoint": "https://auth.rlservers.com/application/o/netbird/.well-known/openid-configuration"
  },
  "PKCEAuthorizationFlow": {
    "ProviderConfig": {
      "ClientID": "netbird",
      "Domain": "auth.rlservers.com",
      "Audience": "netbird",
      "TokenEndpoint": "https://auth.rlservers.com/application/o/token/",
      "AuthorizationEndpoint": "https://auth.rlservers.com/application/o/authorize/",
      "Scope": "openid profile email offline_access",
      "RedirectURLs": ["https://netbird.rlservers.com/auth", "https://netbird.rlservers.com/silent-auth", "https://netbird.rlservers.com/#callback", "http://localhost:53000"],
      "UseIDToken": true
    }
  }
}
```

**CRITICAL: `Scope` is a space-separated STRING, NOT an array.**  
Using `"Scopes": [...]` causes silent JSON unmarshal failure → empty scope → client error.

## SSO PKCE Flow

1. Client calls `GetServerKey` (unauthenticated) → gets server WireGuard public key
2. Client calls `GetPKCEAuthorizationFlow` (encrypted with server key) → gets PKCE config
3. Client opens browser → `https://auth.rlservers.com/application/o/netbird/` → Authentik login
4. Browser redirects to `http://localhost:53000` (desktop) → client captures auth code
5. Client exchanges code for JWT → calls `Login` with JWT → peer registered

**`http://localhost:53000` MUST be in:**
- `management.json` → `PKCEAuthorizationFlow.ProviderConfig.RedirectURLs`
- Authentik provider → `redirect_uris`

## Bootstrap Job

`kubernetes/apps/netbird/manifests/bootstrap-job.yaml` — ArgoCD PostSync hook  
Seeds SQLite DB: account, user `remon` (role=admin, issued=oidc), setup key, groups, routes

## Router Peer

VM 9250 (`netbird-router-vlan3`) at 10.10.0.10 on VLAN3:
- Enrolled in NetBird with setup key
- Advertises `10.10.0.0/24` + `10.25.0.0/24` with masquerade=True
- Allows internal services to be reached via VPN from anywhere
- `*.int.rlservers.com` routes only allow traffic from 10.10.0.10/32 (netbird-vpn-only middleware)

## Relay Config

```json
"Relay": {
  "Addresses": ["rels://netbird.rlservers.com:443/relay"],
  "CredentialsTTL": "12h",
  "Secret": "<random, from OpenBao>"
}
```

## Known Issues

- **Cloudflare 100s timeout:** Long-lived gRPC `Sync` streams are killed every ~100s by Cloudflare.
  NetBird clients reconnect automatically. The `context canceled` logs in management are expected.
- **Pod restarts cause 502:** During management pod restart, clients get 502. They retry and reconnect.
- **instance setup status: false:** Normal INFO log from HTTP API, does NOT block gRPC functionality.
