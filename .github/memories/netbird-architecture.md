---
title: NetBird Architecture — Two Deployments
description: There are two separate NetBird deployments; only the standalone VM one is active for external clients.
---

# NetBird Architecture

## Active Deployment: Standalone VM (10.25.0.100)

**External URL:** `https://netbird.rlservers.com`  
**Port forwards (on router):** 443 TCP → 10.25.0.5 (Traefik), 3478 UDP → 10.25.0.100 (coturn)

### Routing Chain
```
Internet → Router → Traefik (10.25.0.5:443) → NetBird services (10.25.0.100)
```

**NO Caddy in the chain** (Caddy was removed — it caused double-proxy gRPC issues).  
Traefik routes directly to each service by path:

| Path | Backend | Protocol |
|------|---------|----------|
| `/management.ManagementService/*` | 10.25.0.100:8081 | h2c (gRPC) |
| `/management.ProxyService/*` | 10.25.0.100:8081 | h2c (gRPC) |
| `/signalexchange.SignalExchange/*` | 10.25.0.100:10000 | h2c (gRPC) |
| `/relay*` | 10.25.0.100:8084 | HTTP (WebSocket) |
| `/ws-proxy/signal*` | 10.25.0.100:8083 | HTTP (WebSocket) |
| `/api*`, `/ws-proxy/management*` | 10.25.0.100:8081 | HTTP |
| `/oauth*`, `/.well-known*`, `/ui*`, `/device*`, etc. | 10.25.0.100:8082 | h2c (Zitadel) |
| `/*` | 10.25.0.100:8080 | HTTP (Dashboard) |

### Container Port Bindings on 10.25.0.100
- dashboard: `8080:80`
- management: `8081:80`
- signal: `8083:80` (HTTP) + `10000:10000` (gRPC)
- relay: `8084:80`
- zitadel: `8082:8080`
- coturn: `host` mode (UDP 3478 direct)

### Services
- **Management** v0.70.0 — gRPC + REST on port 80 (h2c)
- **Signal** — gRPC on port 10000, HTTP/WS on port 80
- **Relay** — WebSocket on port 80; exposed address `rels://netbird.rlservers.com:443/relay`
- **Zitadel** v2.64.1 — Identity provider on port 8080 (h2c)
- **Coturn** — STUN/TURN on UDP 3478 (host network)
- **Dashboard** — nginx serving React SPA on port 80

## Authentication

### SSO Login (Web/Phone/CLI)
- Identity Provider: **Zitadel** (self-hosted, at `https://netbird.rlservers.com`)
- Dashboard app `client_id`: `370440503272996868`
- CLI/Mobile app `client_id`: `370440503608541188` (device code grant)
- Phone uses **device code flow**: open `https://netbird.rlservers.com/device?user_code=XXXX`
- **Login credentials:** username `admin` (or `remonhulst@gmail.com`), password `NetBird2024!Admin`

### Setup Key Authentication (bypass SSO)
- **CRITICAL:** The setup key ID (UUID in the DB `id` column) is NOT the key itself
- `Key` column = `base64(SHA256(plaintext_key))`
- `KeySecret` = first 4 chars of plaintext + `****`
- **Working setup key plaintext:** `3013F728-5794-4BF8-AA08-9FD0A88EF75D`
- DB location: `/var/lib/docker/volumes/netbird_netbird_management/_data/store.db` on 10.25.0.100

### IDP Manager (user info sync)
- Machine user: `netbird-management`
- Client ID: `netbird-management`
- Client Secret: `MhQfFLOdjjW4qMFj73r3NKCz7uTL7VsqWsIsYYrDjeCTaJtv0J0udun5AkBafuSy`
- Configured in `/opt/netbird/management.json` → `IdpManagerConfig.ClientConfig`

## Files
- `/opt/netbird/docker-compose.yml` — container definitions (no Caddy)
- `/opt/netbird/management.json` — management config (IDP, relay, STUN)
- `/opt/netbird/Caddyfile` — KEPT but not used (Caddy service removed from compose)
- `/home/remon/Traefik/dynamic/netbird.yml` — Traefik routing (on 10.25.0.5)

## Known Issues / Notes
- `etcd corrupt cluster` warnings in K8s — unrelated to NetBird
- Zitadel admin PAT token expires 2026-04-27; machinekey still valid for API calls
- Zitadel org primary domain is `zitadel.netbird.rlservers.com` (internal); external domain correctly set to `netbird.rlservers.com`
- gRPC backward compat server on management port 33073 (for clients < v0.29) — not exposed externally

## Cluster (In-Cluster) Deployment
- Namespace: `netbird` in Talos K8s cluster
- Status: INACTIVE for external clients (not port-forwarded)
- Used internally only


---

## NetBird API Access

**PAT (Personal Access Token):**
- Token ID in SQLite: `nbpat003`
- User: `321996cb-3822-448c-a7d4-de8633b769cd` (NetBird owner)
- Stored in: GitHub secret `NETBIRD_API_TOKEN` (set this in repo settings)
- Format: `nbp_<30 base62 chars><6 char CRC32 checksum>` — SHA256(plainToken) stored as HashedToken

**To generate a new PAT directly in SQLite (if dashboard is inaccessible):**
```bash
# On 10.25.0.100:
python3 -c "
import hashlib, base64, zlib, random
BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
def rand62(n): return ''.join(random.choice(BASE62) for _ in range(n))
def crc62(s):
    v = zlib.crc32(s.encode()) & 0xFFFFFFFF
    r = ''
    while v: r = BASE62[v%62]+r; v //= 62
    return r.rjust(6,'0')
secret = rand62(30)
token = 'nbp_' + secret + crc62(secret)
hashed = base64.b64encode(hashlib.sha256(token.encode()).digest()).decode()
print('PLAIN:', token)
print('HASHED:', hashed)
"
# Then insert:
sudo sqlite3 /var/lib/docker/volumes/netbird_netbird_management/_data/store.db \
  "INSERT OR REPLACE INTO personal_access_tokens (id, name, user_id, hashed_token, expiration_date, created_by, created_at)
   VALUES('nbpat-new', 'api-token', '321996cb-3822-448c-a7d4-de8633b769cd', '<HASHED>', '2027-01-01 00:00:00+00:00', '321996cb-3822-448c-a7d4-de8633b769cd', datetime('now'));"
```

## Network Routes (Current State)

| Network | Via Peer | Purpose |
|---------|----------|---------|
| `10.25.0.0/24` | github-runner (d7ns5ljdeh7s73fm4r00) | LAN access |
| `10.96.0.0/12` | github-runner (d7ns5ljdeh7s73fm4r00) | K8s services |

**Note:** Routes use the always-running github-runner at 10.25.0.108 (NetBird IP 100.91.59.175).  
When K8s is restored, the K8s route (10.96.0.0/12) should be updated to a Talos peer for correct K8s service routing.

## DNS Nameservers

| Name | DNS Server | Domain | State |
|------|-----------|--------|-------|
| k8s-internal-dns | 10.96.0.10 | prod.local | **DISABLED** — K8s down |

Re-enable once K8s API is working: `PATCH /api/dns/nameservers/d7nn56jdeh7s7388jdc0` with `enabled: true`.

## Peer Cleanup Automation

Script: `.github/scripts/netbird_cleanup_peers.sh <pattern>`  
Called automatically in `full-redeploy.yml` before destroy step.  
Requires: `NETBIRD_API_TOKEN` GitHub secret.

**Only deletes OFFLINE peers** matching the hostname pattern — never deletes connected peers.

## Zitadel Admin User

- Username: `admin` (login name: `admin` or `remonhulst@gmail.com`)
- Password: `NetBird2024!Admin`
- State: `USER_STATE_ACTIVE`, `isEmailVerified: true`
- User ID (Zitadel): `370538366334140418`

## Common Issues & Fixes

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Dashboard inaccessible when on NetBird | Route 10.25.0.0/24 via offline K8s peer | Change route to always-running peer |
| "DNS servers can't connect" on phone | K8s CoreDNS (10.96.0.10) not reachable | Disable k8s-internal-dns nameserver |
| 40+ stale Talos peers | Multiple redeploys without cleanup | `NETBIRD_API_TOKEN=$TOKEN bash .github/scripts/netbird_cleanup_peers.sh talos-prod` |
| PAT "token invalid" | Wrong hash format or missing `nbp_` prefix | See PAT generation section above |
