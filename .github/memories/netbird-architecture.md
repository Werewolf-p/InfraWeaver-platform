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

| Name | ID | DNS Server | Domain | State |
|------|-----|-----------|--------|-------|
| rlservers-internal | d7o5p2rdeh7s73fcv43g | **10.25.0.201:53** | rlservers.com | ENABLED |
| k8s-internal-dns | d7nn56jdeh7s7388jdc0 | **10.25.0.201:53** | prod.local | ENABLED |

**IMPORTANT:** Both nameservers point to **in-cluster CoreDNS at 10.25.0.201** (MetalLB LoadBalancer).

### In-Cluster CoreDNS (10.25.0.201)
- **App:** `apps-dns` in ArgoCD
- **Namespace:** `dns-system`
- **Manifests:** `kubernetes/apps/dns/manifests/`
- **MetalLB IP:** `10.25.0.201` (static, annotated on Service)
- **Accessible from:** 10.25.0.0/24 LAN + NetBird VPN peers (via 10.25.0.0/24 route)
- **Replicas:** 2 (spread across nodes for HA)

### Why NOT kube-dns CoreDNS (10.96.0.10)?
- `10.96.0.10` is a Kubernetes ClusterIP — **only reachable from within cluster nodes**
- External NetBird peers (phones, laptops) cannot route to `10.96.0.10`
- Causes: "Warning: DNS — Unable to reach one or more DNS servers"

### DNS Record Sources
All DNS is now IaC in platform repo: `kubernetes/apps/dns/manifests/configmap.yaml`

| Domain | Resolves to | Purpose |
|--------|-------------|---------|
| *.rlservers.com (most) | 10.25.0.5 | Standalone Traefik |
| netbird.rlservers.com | 10.25.0.100 | NetBird VM |
| dc1.rlservers.com | 10.25.0.43 | Windows domain controller |
| *.prod.local | 10.25.0.200 | Cluster Traefik (in-cluster ingress) |

### dnsmasq on 10.25.0.108 (forwarding only)
Config: `/etc/dnsmasq.d/rlservers-split-dns.conf`
- Now only **forwards** `rlservers.com` and `prod.local` to `10.25.0.201`
- No longer contains direct A records (those are in CoreDNS configmap)

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
| "DNS servers can't connect" on phone | K8s CoreDNS (10.96.0.10) not reachable externally | Change k8s-internal-dns nameserver to 10.25.0.108:53; add prod.local entries to dnsmasq |
| 40+ stale Talos peers | Multiple redeploys without cleanup | `NETBIRD_API_TOKEN=$TOKEN bash .github/scripts/netbird_cleanup_peers.sh talos-prod` |
| PAT "token invalid" | Wrong hash format or missing `nbp_` prefix | See PAT generation section above |

---

## Admin Permissions & Domain Fix (2026-04-28)

### Issue: Admin user had `role = 'user'` in NetBird DB
**Fix:** Updated SQLite directly:
```sql
UPDATE users SET role='admin' WHERE id='370538366334140418';
```
- User ID `370538366334140418` = Zitadel `admin` user (remonhulst@gmail.com)
- User ID `321996cb-3822-448c-a7d4-de8633b769cd` = original NetBird owner (service user)
- Management service restarted after DB change

### Issue: Domain showed "netbird.selfhosted" instead of "rlservers.com"
**Fix:** Updated accounts table:
```sql
UPDATE accounts SET domain='rlservers.com' WHERE id='ff70dcdf-66bc-476e-9095-6c1b00ff63ce';
```
- The `domain` field in NetBird is for **internal peer DNS** (peers get DNS names like `peer.rlservers.com`)
- This is SEPARATE from the HTTPS/API domain (netbird.rlservers.com)
- The `netbird.selfhosted` was the default left over from initial setup

### DB location on 10.25.0.100:
`/var/lib/docker/volumes/netbird_netbird_management/_data/store.db`


---

## Runner Infrastructure (2026-04-28)

### Platform runner registered on management-host VM
- **VM:** github-runner-productie at 10.25.0.108
- **Runner name:** `management-host-platform`
- **Registered repo:** InfraWeaver-platform
- **Labels:** `self-hosted, Linux, X64, prod-worker`
- **Service:** `actions.runner.Werewolf-p-InfraWeaver-platform.management-host-platform`
- **Runner dir:** `/opt/platform-runner/`

This runner was added because the original "productie" runner (ID 23) was on pve-prod1 which went down. The management-host-platform runner ensures platform workflows can run even when pve-prod1 is offline.

### pve-prod1 outage (2026-04-28)
- pve-prod1 (10.25.0.80) went completely offline mid-workflow
- Affected VMs: talos-prod-cp1 (9300), openbao-productie (9200), original productie runner
- Remaining cluster VMs (9301/9302) were destroyed to clean state
- **When pve-prod1 comes back:** destroy VM 9300, then run full-redeploy workflow


---

## Split-DNS for rlservers.com via NetBird (2026-04-28)

### Problem
When connected to NetBird from outside the home network, DNS for `argocd.rlservers.com` etc resolves to the public IP (84.82.69.110). Traefik's `internal-only` middleware blocks external source IPs — the service is unreachable.

### Solution: dnsmasq split-DNS on management host + NetBird nameserver
- **dnsmasq** runs on `10.25.0.108:53` (service: `dnsmasq`)
- Config: `/etc/dnsmasq.d/rlservers-split-dns.conf`
- Maps all rlservers.com service names → `10.25.0.5` (standalone Traefik)
- NetBird nameserver group `rlservers-internal` (ID: `d7o5p2rdeh7s73fcv43g`) routes `rlservers.com` queries to `10.25.0.108`
- Effect: when connected to NetBird, `argocd.rlservers.com` → `10.25.0.5` → Traefik sees source as NetBird IP (`100.x.x.x`) → allowed by `100.64.0.0/10` in `internal-only` middleware

### Service name → IP mappings
| Domain | Resolves to | Via |
|---|---|---|
| argocd.rlservers.com | 10.25.0.5 | dnsmasq |
| grafana.rlservers.com | 10.25.0.5 | dnsmasq |
| longhorn.rlservers.com | 10.25.0.5 | dnsmasq |
| netbird.rlservers.com | 10.25.0.5 | dnsmasq |
| test.rlservers.com | 10.25.0.5 | dnsmasq |
| argocd.prod.local | 10.25.0.200 | dnsmasq → cluster Traefik |
| grafana.prod.local | 10.25.0.200 | dnsmasq → cluster Traefik |
| longhorn.prod.local | 10.25.0.200 | dnsmasq → cluster Traefik |
| test.prod.local | 10.25.0.200 | dnsmasq → cluster Traefik |
| netbird.prod.local | 10.25.0.200 | dnsmasq → cluster Traefik |

### Peer DNS domain fix
- `settings_dns_domain` in accounts table was EMPTY → peers showed `*.netbird.selfhosted`
- Fixed: `UPDATE accounts SET settings_dns_domain='rlservers.com'`
- The `domain` field is for SSO/Zitadel, NOT for peer DNS suffixes
- After management restart, peers show `*.rlservers.com` DNS labels

