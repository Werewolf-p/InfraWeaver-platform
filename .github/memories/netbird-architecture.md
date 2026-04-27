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

