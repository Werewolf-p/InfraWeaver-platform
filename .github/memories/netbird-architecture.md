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

**IngressRoute:** `kubernetes/platform/external-routes/manifests/09-routes-netbird.yaml`

### api-netbird.rlservers.com (API/gRPC)
| Path | Backend | Port | Scheme |
|------|---------|------|--------|
| `/management.ManagementService/*` | netbird-management | 33073 | h2c |
| `/signalexchange.SignalExchange/*` | netbird-signal | 10000 | h2c |
| `/grpc.reflection/*` | netbird-signal | 10000 | h2c |
| `/relay/*` | netbird-relay | 443 | http |
| `/api/*`, `/ws-proxy/*` | netbird-management | 80 | http |

**IngressRoute:** `kubernetes/platform/external-routes/manifests/10-routes-netbird-api.yaml`  
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
Template: `kubernetes/platform/netbird/manifests/management.yaml` (ConfigMap)  
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

`kubernetes/platform/netbird/manifests/bootstrap-job.yaml` — ArgoCD PostSync hook  
Seeds SQLite DB: account, user `remon` (role=admin, issued=oidc), setup key, groups, routes

## Router Peer (Dedicated VM — May 2026)

**IMPORTANT: The DaemonSet approach was REMOVED. Use a dedicated VM instead.**

NetBird routing is handled by a dedicated VM `netbird-router-vlan3` (Proxmox VM ID 9200).

| Property | Value |
|----------|-------|
| VM name | `netbird-router-vlan3` |
| VLAN3 IP | `10.10.0.10` |
| NetBird VPN IP | `100.72.214.95` (dynamic, reassigned on re-enrollment) |
| NetBird group | `routing-peers-vlan3` |
| Routes advertised | `10.10.0.0/24` + `10.25.0.0/24` |
| Management URL | `http://10.10.0.202` (internal MetalLB VIP, no TLS) |

**Why dedicated VM (not DaemonSet):**
- DaemonSet pods restart frequently → new WireGuard keys each restart → stale peer accumulation
- Even with hostPath persistence, 3 nodes × N restarts = many peers
- Dedicated VM: static WireGuard key persists in `/etc/netbird/config.json` at `/var/lib/netbird`
- Only ONE routing peer in `routing-peers-vlan3` group → clean state always

**Enrollment:**
```bash
# VM MUST use internal MetalLB management VIP (api-netbird.rlservers.com via Traefik has gRPC issues)
sudo netbird up --management-url http://10.10.0.202 --setup-key A1B2C3D4-E5F6-7890-ABCD-EF1234567890
```
The Terraform module (`terraform/modules/netbird-router/main.tf`) uses `netbird_management_url = "http://10.10.0.202"`.

**MASQUERADE rule (critical):**
The VM has a systemd service `netbird-masq.service` that adds:
```
iptables -t nat -A POSTROUTING -s 100.64.0.0/10 ! -d 100.64.0.0/10 -j MASQUERADE
```
Without this, VPN clients can route to VLAN3 but responses don't masquerade back.
This is added by Terraform setup script and persisted via systemd.

**`netbird-vpn-only` middleware allows `10.10.0.10`** (the VM's masquerade source IP) because
it's in `10.10.0.0/24` range (already in the allowlist).

**Stale peer cleanup:**
- Bootstrap job (PostSync hook) runs `python3 /script/cleanup.py` after management restarts
- Keeps newest peer per name, deletes duplicates
- YAML-SAFE: cleanup code is in the ConfigMap's `cleanup.py` entry (NOT as a heredoc)

Files:
- ~~DaemonSet~~: **DELETED** `kubernetes/platform/netbird/manifests/client-daemonset.yaml`
- Router Terraform: `terraform/modules/netbird-router/main.tf` + `terraform/main.tf`
- Bootstrap: `kubernetes/platform/netbird/manifests/bootstrap-job.yaml`

## Routes

| net_id | Network | Description |
|--------|---------|-------------|
| `vlan3-net` | `10.10.0.0/24` | VLAN 3 network route |
| `homelab-net` | `10.25.0.0/24` | Homelab management network route |

Both routes use `peer_groups = [GRP_ROUTING]` (only router VM advertises) and `groups = [GRP]` (all peers use).

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
  **Fix (dedicated VM):** Terraform setup script creates `/etc/systemd/system/netbird-masq.service`
  which adds the MASQUERADE rule persistently on boot.
  Verify: `ssh ubuntu@10.10.0.10 "sudo iptables -t nat -S POSTROUTING | grep 100.64"`

- **Cluster-internal DNS:** NetBird clients run inside the cluster and use cluster DNS (10.96.0.10).
  `netbird.rlservers.com` AND `api-netbird.rlservers.com` MUST be in
  `kubernetes/platform/dns/manifests/configmap.yaml` → `rlservers.com.hosts`.
  Missing entry causes `server misbehaving` → clients crash loop.
- **wait-for-oidc init container:** Management will not start until `auth.rlservers.com` OIDC endpoint
  is reachable with a valid TLS cert. If Authentik cert is rate-limited/missing, management stays in Init.
  Fix: ensure `auth.rlservers.com` is in `rlservers-com-wildcard` cert SANs (not a separate cert).

## Authentik Branding (May 2026)

Custom branding images stored in the repo at `images/`:
- `images/banner.png` — original (1.3MB, not used in runtime)
- `images/banner.jpg` — 800×533 JPEG, 18KB (**login page logo/hero image** in card header)
- `images/logo.png` — 200×200 PNG, 22KB (archived; banner.jpg now used as branding_logo)
- `images/favicon.png` — 64×64 PNG, 3KB (browser favicon)

These are bundled into ConfigMap `authentik-media` (`kubernetes/platform/authentik/manifests/media-configmap.yaml`)
and mounted with `subPath` into `/web/dist/assets/icons/` in Authentik server+worker pods.

Static URLs (permanent, no JWT expiry):
- `https://auth.rlservers.com/static/dist/assets/icons/banner.jpg`
- `https://auth.rlservers.com/static/dist/assets/icons/favicon.png`

Blueprint `InfraWeaver Branding` (`kubernetes/platform/authentik/manifests/blueprint-branding.yaml`) sets:
- `branding_title: "rlservers.com"`
- `branding_logo: /static/dist/assets/icons/banner.jpg` (full-width banner strip at card top, 155px height)
- `branding_favicon: /static/dist/assets/icons/favicon.png`
- **Aurora / glassmorphism theme** (no constant animations):
  - Deep space base: bg `#070b14`
  - Static indigo/violet radial gradient aurora overlay (`html::before`)
  - Glassmorphism card: `backdrop-filter: blur(28px)`, `rgba(10,14,30,0.78)` fill, indigo border
  - Full-width banner: padding:0, `object-fit: cover`, 155px height strip touching card edges
  - "Welcome to rlservers.com" title via CSS `::after` on `.pf-c-login__main-header .pf-c-title`
  - Primary button: indigo→violet gradient with hover lift (translateY -1px) — only on hover

**⚠️ Why NOT `/media/public/`?**
Authentik's `FileBackend` serves files at `/files/media/public/<name>?token=JWT` with 15-minute
JWT expiry. These URLs cannot be hardcoded in blueprints or CSS (they expire). Static files
(`/web/dist/assets/icons/`) are served without auth at `/static/dist/...` — permanent URLs.

## Routes (May 2026)

Both routes use `routing-peers-vlan3` as `peer_groups` (NOT "All"):
- `10.10.0.0/24` (VLAN3) — routed by `netbird-router-vlan3` VM (10.10.0.10)
- `10.25.0.0/24` (homelab management LAN) — also routed by `netbird-router-vlan3` VM

Access group (`groups`) = All — all VPN peers can use these routes.
Using "All" as peer_groups for 10.25.0.0/24 was a bug — caused user's phone/PC to advertise
cluster routes, breaking routing when those devices are offline.
# Post-Redeploy Reliability Fixes (May 2026)

## Issues Fixed

### 1. Authentik API Token Intent (CRITICAL)
- `Token.objects.get_or_create()` with no `intent` field creates `INTENT_VERIFICATION` tokens
- These DO NOT work with `Authorization: Bearer <token>` REST API calls
- Must use `TokenIntents.INTENT_API` for API tokens:
  ```python
  from authentik.core.models import Token, TokenIntents, User
  Token.objects.filter(identifier='gh-actions-api-token').delete()
  t = Token.objects.create(identifier='...', user=admin, intent=TokenIntents.INTENT_API, expiring=False)
  ```
- **Fixed in**: `full-redeploy.yml` recovery email step

### 2. Authentik Recovery Flow Missing
- Password recovery API (`POST /api/v3/core/users/{id}/recovery/`) requires a recovery flow
- A flow with `designation=FlowDesignation.RECOVERY` must exist AND be set on the brand
- **Fixed in**: `blueprint-branding.yaml` now creates `default-recovery-flow` and sets it on the brand
- Without this: `{"non_field_errors":"No recovery flow set."}` 400 error

### 3. cert-manager ClusterIssuers Not Persisted
- `letsencrypt-http`, `letsencrypt-cloudflare`, `selfsigned-issuer` were in `kubernetes/core/cert-manager/manifests/`
- But there was NO ArgoCD app pointing to that path!
- After redeploy, they were missing → wildcard cert couldn't be issued → Authentik broken → NetBird stuck in init
- **Fixed**: Created `kubernetes/bootstrap/core-cert-manager-manifests.yaml` ArgoCD app
- App: `core-cert-manager-manifests`, path: `kubernetes/core/cert-manager/manifests/`

### 4. NetBird Router VM Disconnects After Redeploy
- Full redeploy wipes local-path PVC data (SQLite DB) → old peer key rejected
- **Fixed**: Added `netbird-watchdog.service` to router VM
  - Polls every 60s, detects disconnect, auto re-enrolls with setup key
  - Service: `/usr/local/bin/netbird-reconnect.sh` → `/etc/systemd/system/netbird-watchdog.service`
  - Also added `netbird down` before `netbird up` in Terraform configure script

### 5. NetBird API Path (Not /api/v1)
- NetBird management REST API is at `/api/` prefix, NOT `/api/v1/`
- Correct: `GET /api/peers`, `GET /api/routes`, `GET /api/dns/nameservers`
- Wrong: `GET /api/v1/peers` (returns 404 page not found)

## Current State (Post-Fix)

### Platform Status
- ✅ OIDC endpoint: `https://auth.rlservers.com/application/o/netbird/.well-known/openid-configuration`
- ✅ NetBird API: `https://api-netbird.rlservers.com/api/peers` (1 peer: router VM online)
- ✅ Routes: `homelab-net` (10.25.0.0/24) + `vlan3-net` (10.10.0.0/24)
- ✅ DNS groups: prod-local, rlservers-com, int-rlservers-com all → 10.10.0.201
- ✅ Recovery flow: `default-recovery-flow` set on brand `authentik-default`
- ✅ Branding: title="rlservers.com", logo/favicon set
- ✅ ClusterIssuers: all 3 Ready and managed by ArgoCD `core-cert-manager-manifests`
- ✅ Watchdog service running on router VM (10.10.0.10)

### PAT Token Location
- K8s secret: `kubectl get secret netbird-secrets -n netbird -o jsonpath='{.data.netbird-pat-token}' | base64 -d`
- Current: `nbp_lPRAdJBQ...` (use `Token` header for NetBird API)

### Router VM
- IP: 10.10.0.10 (VLAN3 static)
- NetBird IP: 100.119.13.113 (changes on re-enroll but that's fine)
- Groups: All, routing-peers-vlan3
- Services: netbird, netbird-masq (MASQUERADE), netbird-watchdog (auto re-enroll)
