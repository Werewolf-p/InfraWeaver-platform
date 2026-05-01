---
title: NetBird Architecture — Kubernetes deployment on VLAN3
description: NetBird runs entirely in Kubernetes (VLAN3). Dashboard at netbird.rlservers.com (public), API/gRPC at api-netbird.rlservers.com.
---

# NetBird Architecture (Current — May 2026)

## Deployment

NetBird runs fully in Kubernetes (`netbird` namespace) on the VLAN3 cluster (10.10.0.0/24).  
**Old VM-based deployment at 10.25.0.100 is decommissioned.**

## Domain Split (Dashboard vs API)

| Domain | Purpose |
|--------|---------|
| `netbird.rlservers.com` | Web dashboard (**public** — must NOT be VPN-only, see lesson below) |
| `api-netbird.rlservers.com` | Management gRPC, Signal gRPC, Relay, REST API |

Both point to Traefik at `10.10.0.200`. The split ensures NetBird desktop/mobile clients pick
the correct redirect URI for PKCE auth (see SSO PKCE flow below).

## ⚠️ Dashboard Must Stay Public (Chicken-and-Egg Lesson)

**NEVER restrict `netbird.rlservers.com` to VPN-only (`netbird-vpn-only` middleware).**

Reason: You need the dashboard to manage VPN peers and onboard new devices.
If the dashboard is VPN-only and a device loses its VPN key or is being set up fresh,
you are completely locked out — can't connect to VPN (need dashboard for setup keys)
and can't reach dashboard (not on VPN yet).

- Dashboard at `netbird.rlservers.com` → **always public, no middleware**
- Internal services at `*.int.rlservers.com` → VPN-only (`netbird-vpn-only` middleware) ✅

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

### api-netbird.rlservers.com (API/gRPC)
| Path | Backend | Port | Scheme |
|------|---------|------|--------|
| `/management.ManagementService/*` | netbird-management | 33073 | h2c |
| `/signalexchange.SignalExchange/*` | netbird-signal | 10000 | h2c |
| `/grpc.reflection/*` | netbird-signal | 10000 | h2c |
| `/relay/*` | netbird-relay | 443 | http |
| `/api/*`, `/ws-proxy/*` | netbird-management | 80 | http |

**IngressRoute:** `kubernetes/apps/external-routes/manifests/10-routes-netbird-api.yaml`  
**TLS cert:** `rlservers-com-wildcard-tls` (includes `api-netbird.rlservers.com` SAN)  
**Cloudflare DNS:** `api-netbird.rlservers.com` A → `84.82.69.110` (**DNS-only, proxied=false**)

## Cloudflare Requirements

- **`api-netbird.rlservers.com` should be DNS-only (proxied=false)** — see Known Issues below
- **`netbird.rlservers.com` can be proxied** (one level under apex, covered by `*.rlservers.com` edge cert)
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
  "Signal": {"Proto":"https","URI":"api-netbird.rlservers.com:443"},
  "Relay": {
    "Addresses": ["rels://api-netbird.rlservers.com:443/relay"]
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

## Setup Key

The default setup key is stored in OpenBao `secret/platform/netbird.SETUP_KEY`.
Value set during redeploy: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`  
This is a **reusable** key — use it to enroll any new device without SSO.

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

## Router Peer (DaemonSet, current — May 2026)

NetBird client runs as a **DaemonSet** (`netbird-client`) on all K8s nodes (VLAN3: 10.10.0.90-92).  
Each pod has `hostNetwork: true` and connects to management at `https://api-netbird.rlservers.com`.  
All pods advertise `10.10.0.0/24` with `masquerade=True` via route group `routing-peers-vlan3` (`GRP_ROUTING`).  
VPN clients reach internal services through these DaemonSet routing peers.

**Key requirements:**
- `NB_MANAGEMENT_URL` MUST be `https://api-netbird.rlservers.com` (not dashboard URL!)
- Setup key `auto_groups` MUST include `GRP_ROUTING` so pods auto-join `routing-peers-vlan3` group
- `netbird-vpn-only` middleware allows `10.10.0.0/24` (K8s node VLAN3 IPs — masquerade source)

Files:
- DaemonSet: `kubernetes/apps/netbird/manifests/client-daemonset.yaml`
- Bootstrap: `kubernetes/apps/netbird/manifests/bootstrap-job.yaml` (sets up key auto_groups, route with peer_groups)

## Relay Config

```json
"Relay": {
  "Addresses": ["rels://api-netbird.rlservers.com:443/relay"],
  "CredentialsTTL": "12h",
  "Secret": "<random, from OpenBao>"
}
```

## Known Issues

- **`api-netbird.rlservers.com` is DNS-only (`proxied=false`) for gRPC reliability** — single-level
  subdomain covered by the `*.rlservers.com` edge cert, but DNS-only avoids the Cloudflare 100s
  stream timeout and relay interference. Enforced in: `full-redeploy.yml`
  "Ensure Cloudflare DNS records for api-netbird.rlservers.com" step.
  Quick fix: `.github/workflows/fix-cloudflare-dns.yml` (workflow_dispatch).

- **Cloudflare 100s timeout:** Long-lived gRPC `Sync` streams are killed every ~100s by Cloudflare.
  NetBird clients reconnect automatically. The `context canceled` logs in management are expected.
- **Pod restarts cause 502:** During management pod restart, clients get 502. They retry and reconnect.
- **instance setup status: false:** Normal INFO log from HTTP API, does NOT block gRPC functionality.
- **NetBird v0.70 missing MASQUERADE rule (CRITICAL):** NetBird v0.70.x sets FORWARD iptables rules
  but does NOT add a POSTROUTING MASQUERADE rule for the VPN subnet (`100.64.0.0/10`). Without this,
  traffic from external VPN peers (e.g., RemonPC at `100.78.x.x`) forwarded to VLAN3 retains the
  VPN source IP. VLAN3 can't route back to VPN IPs → DNS (to 10.10.0.201) fails → DNS_PROBE_POSSIBLE.
  **Fix:** `postStart` lifecycle hook in `client-daemonset.yaml` adds:
  `iptables -t nat -A POSTROUTING -s 100.64.0.0/10 ! -d 100.64.0.0/10 -j MASQUERADE`
  Verify: `kubectl exec -n netbird netbird-client-XXXX -- iptables -t nat -S POSTROUTING | grep 100.64`

- **Cluster-internal DNS:** NetBird clients run inside the cluster and use cluster DNS (10.96.0.10).
  `netbird.rlservers.com` AND `api-netbird.rlservers.com` MUST be in
  `kubernetes/apps/dns/manifests/configmap.yaml` → `rlservers.com.hosts`.
  Missing entry causes `server misbehaving` → clients crash loop.
- **wait-for-oidc init container:** Management will not start until `auth.rlservers.com` OIDC endpoint
  is reachable with a valid TLS cert. If Authentik cert is rate-limited/missing, management stays in Init.
  Fix: ensure `auth.rlservers.com` is in `rlservers-com-wildcard` cert SANs (not a separate cert).

## Authentik Branding (May 2026)

Custom branding images stored in the repo at `images/`:
- `images/banner.png` — original (1.3MB, not used in runtime)
- `images/banner.jpg` — 800×533 JPEG, 18KB (login page background)
- `images/logo.png` — 200×200 PNG, 22KB (brand logo)
- `images/favicon.png` — 64×64 PNG, 3KB (browser favicon)

These are bundled into ConfigMap `authentik-media` (`kubernetes/apps/authentik/manifests/media-configmap.yaml`)
and mounted with `subPath` into `/web/dist/assets/icons/` in Authentik server+worker pods.

Static URLs (permanent, no JWT expiry):
- `https://auth.rlservers.com/static/dist/assets/icons/logo.png`
- `https://auth.rlservers.com/static/dist/assets/icons/favicon.png`
- `https://auth.rlservers.com/static/dist/assets/icons/banner.jpg`

Blueprint `InfraWeaver Branding` (`kubernetes/apps/authentik/manifests/blueprint-branding.yaml`)
sets `branding_logo: /static/dist/assets/icons/logo.png` and
`branding_favicon: /static/dist/assets/icons/favicon.png`.
CSS uses `url("/static/dist/assets/icons/banner.jpg")` as login page background.

**⚠️ Why NOT `/media/public/`?**
Authentik's `FileBackend` serves files at `/files/media/public/<name>?token=JWT` with 15-minute
JWT expiry. These URLs cannot be hardcoded in blueprints or CSS (they expire). Static files
(`/web/dist/assets/icons/`) are served without auth at `/static/dist/...` — permanent URLs.
