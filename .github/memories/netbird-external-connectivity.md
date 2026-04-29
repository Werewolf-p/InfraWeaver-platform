---
title: NetBird External Connectivity Fix
description: How to diagnose and fix NetBird VPN when external peers cannot connect
---

# NetBird External Connectivity Fix

## Memory

- **File paths:**
  - `kubernetes/apps/netbird/manifests/management.yaml` — Signal URI and TURNs config
  - `kubernetes/apps/netbird/manifests/relay.yaml` — relay NB_EXPOSED_ADDRESS and ports
  - `kubernetes/apps/dns/manifests/configmap.yaml` — prod.local DNS zone
  - `kubernetes/core/traefik/manifests/middleware-netbird.yaml` — IPAllowList for VPN-only services
  - `/home/remon/Traefik/dynamic/netbird.yml` (Traefik VM 10.25.0.5) — relay backend port

- **Decision:** Signal URI must use external public URL; relay listens on the port from NB_EXPOSED_ADDRESS

- **Why it matters:**
  - If `management.json` contains internal IPs for Signal/TURN, external peers get config they cannot route to
  - ArgoCD is GitOps source of truth — direct `kubectl apply` is reverted immediately, changes MUST go through Git
  - The init container originally had an `if [ ! -f management.json ]` guard — changed to always regenerate so config changes take effect on pod restart

- **Relay Port Derivation:**
  - NetBird relay v0.70+ derives its **listen port from `NB_EXPOSED_ADDRESS`**
  - `NB_EXPOSED_ADDRESS=rels://netbird.rlservers.com:443/relay` → relay listens on `:443`
  - K8s service targetPort and Traefik backend must BOTH match the relay's actual listen port
  - Fix: service port `33080→443`, Traefik backend `10.25.0.202:33080→10.25.0.202:443`

- **Signal Config:**
  - Signal URI in management.json template: `https://netbird.rlservers.com:443`
  - Proto must be `https` (not `http`) for TLS — Traefik terminates TLS and forwards via `h2c://`
  - TURNs must be `[]` in v0.70+ — relay replaces TURN

- **Validation:** Check `management.json` inside pod:
  ```bash
  kubectl exec -n netbird netbird-management-0 -- cat /var/lib/netbird/management.json
  ```
  Expected: Signal `https://netbird.rlservers.com:443`, TURNs `[]`

- **Relay path routing:**
  - Traefik: `PathPrefix('/relay')` → `http://10.25.0.202:443`
  - relay must accept connections at `/relay` path (this is built-in, controlled by `NB_EXPOSED_ADDRESS`)
  - Test: `curl https://netbird.rlservers.com/relay` should return `426 Upgrade Required` (WebSocket expected = relay is healthy)

## IPAllowList / VPN Routing Masquerade — CRITICAL

- **The route has `masquerade: true`** (check with NetBird API: `GET /api/routes`)
- NetBird `netbird-client` DaemonSet pods run with `hostNetwork: true` on each K8s node
- Nodes: `10.25.0.90` (cp1), `10.25.0.91` (cp2), `10.25.0.92` (cp3)
- When VPN clients route through the `10.25.0.0/24` subnet via NetBird, masquerade replaces the VPN source IP (`100.64.x.x`) with the **node's LAN IP**
- **Traefik sees `10.25.0.90-92`, NOT `100.64.x.x`**
- **WRONG allowlist:** `10.25.0.108/32` (github runner — NOT a routing peer)
- **CORRECT allowlist:** `10.25.0.0/24` (full homelab LAN — covers all K8s nodes)

Correct middleware sourceRange:
```yaml
sourceRange:
  - 100.64.0.0/10    # Direct WireGuard peers (non-masquerade)
  - 10.25.0.0/24     # K8s nodes masquerading VPN traffic
  - 127.0.0.1/32
```

- **Lesson learned:**
  - Relay `NB_EXPOSED_ADDRESS` port ≠ K8s service containerPort when original was 33080 but v0.70 uses the exposed address port
  - Always restart management pod after config changes (init container regenerates management.json on start)
  - CoreDNS prod.local hosts file must include every service that needs .prod.local resolution
  - The github runner IP (`10.25.0.108`) is NOT a routing peer — the netbird-client DaemonSet pods on the K8s nodes are the routing peers
