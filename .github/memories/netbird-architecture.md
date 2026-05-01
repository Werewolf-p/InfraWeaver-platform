---
title: NetBird Architecture — Kubernetes deployment on VLAN3
description: NetBird runs entirely in Kubernetes (VLAN3). Dashboard at netbird.rlservers.com, API/gRPC at api.netbird.rlservers.com.
---

# NetBird Architecture (Current — May 2026)

## Deployment

NetBird runs fully in Kubernetes (`netbird` namespace) on the VLAN3 cluster (10.10.0.0/24).  
**Old VM-based deployment at 10.25.0.100 is decommissioned.**

## Domain Split (Dashboard vs API)

| Domain | Purpose |
|--------|---------|
| `netbird.rlservers.com` | Web dashboard ONLY |
| `api.netbird.rlservers.com` | Management gRPC, Signal gRPC, Relay, REST API |

Both point to Traefik at `10.10.0.200`. The split ensures NetBird desktop/mobile clients pick
the correct redirect URI for PKCE auth (see SSO PKCE flow below).

## MetalLB VIPs (Internal)

| VIP | Service | Port |
|-----|---------|------|
| 10.10.0.202 | netbird-management-lb | 80, 33073 |
| 10.10.0.203 | netbird-signal-lb | 10000 |
| 10.10.0.204 | netbird-relay | 443 |

## External Access (via Cloudflare → Traefik)

### netbird.rlservers.com (dashboard)
| Path | Backend | Port |
|------|---------|------|
| `/*` | netbird-dashboard | 80 |

**IngressRoute:** `kubernetes/apps/external-routes/manifests/09-routes-netbird.yaml`

### api.netbird.rlservers.com (API/gRPC)
| Path | Backend | Port | Scheme |
|------|---------|------|--------|
| `/management.ManagementService/*` | netbird-management | 33073 | h2c |
| `/signalexchange.SignalExchange/*` | netbird-signal | 10000 | h2c |
| `/grpc.reflection/*` | netbird-signal | 10000 | h2c |
| `/relay/*` | netbird-relay | 443 | http |
| `/api/*`, `/ws-proxy/*` | netbird-management | 80 | http |

**IngressRoute:** `kubernetes/apps/external-routes/manifests/10-routes-netbird-api.yaml`  
**TLS cert:** `rlservers-com-wildcard-tls` (includes `api.netbird.rlservers.com` SAN)  
**Cloudflare DNS:** `api.netbird.rlservers.com` A → `10.10.0.200` (DNS-only, not proxied)

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
  "Signal": {"Proto":"https","URI":"api.netbird.rlservers.com:443"},
  "Relay": {
    "Addresses": ["rels://api.netbird.rlservers.com:443/relay"]
  },
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
      "Scope": "openid profile email offline_access",
      "RedirectURLs": ["http://localhost:53000"],
      "UseIDToken": true
    }
  }
}
```

**CRITICAL: `Scope` is a space-separated STRING, NOT an array.**  
Using `"Scopes": [...]` causes silent JSON unmarshal failure → empty scope → client error.

**CRITICAL: `RedirectURLs` must ONLY contain `http://localhost:53000`.**  
Including web dashboard URLs (`/auth`, `/#callback`) as redirect URIs causes the NetBird client
to pick the wrong redirect URI (see SSO PKCE flow below).

## SSO PKCE Flow

1. Client calls `GetServerKey` (unauthenticated) → gets server WireGuard public key
2. Client calls `GetPKCEAuthorizationFlow` (encrypted with server key) → gets PKCE config
3. Client opens browser → `https://auth.rlservers.com/application/o/netbird/` → Authentik login
4. Browser redirects to `http://localhost:53000` (desktop) → client captures auth code
5. Client exchanges code for JWT → calls `Login` with JWT → peer registered

**Why `localhost:53000` must be the ONLY redirect URI in management.json:**

The NetBird client iterates `PKCEAuthorizationFlow.ProviderConfig.RedirectURLs` and picks the
**FIRST URL whose port is NOT currently in use locally** (checks via `net.DialTimeout("tcp", ":PORT", 3s)`).
- `https://netbird.rlservers.com/auth` has port 443
- Port 443 is NOT running locally on user machines → selected first
- Client sends `redirect_uri=https://netbird.rlservers.com/auth` to Authentik
- Auth code goes to the WEB DASHBOARD, not to the client
- Client waits for localhost callback that never comes → timeout → infinite `/auth` loop

Fix: Only `http://localhost:53000` in `RedirectURLs`. Client always picks port 53000 (not in use).

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
  "Addresses": ["rels://api.netbird.rlservers.com:443/relay"],
  "CredentialsTTL": "12h",
  "Secret": "<random, from OpenBao>"
}
```

## Known Issues

- **Cloudflare 100s timeout:** Long-lived gRPC `Sync` streams are killed every ~100s by Cloudflare.
  NetBird clients reconnect automatically. The `context canceled` logs in management are expected.
- **Pod restarts cause 502:** During management pod restart, clients get 502. They retry and reconnect.
- **instance setup status: false:** Normal INFO log from HTTP API, does NOT block gRPC functionality.
- **Cluster-internal DNS:** NetBird clients run inside the cluster and use cluster DNS (10.96.0.10).
  `netbird.rlservers.com` AND `api.netbird.rlservers.com` MUST be in
  `kubernetes/apps/dns/manifests/configmap.yaml` → `rlservers.com.hosts`.
  Missing entry causes `server misbehaving` → clients crash loop.
- **wait-for-oidc init container:** Management will not start until `auth.rlservers.com` OIDC endpoint
  is reachable with a valid TLS cert. If Authentik cert is rate-limited/missing, management stays in Init.
  Fix: ensure `auth.rlservers.com` is in `rlservers-com-wildcard` cert SANs (not a separate cert).

