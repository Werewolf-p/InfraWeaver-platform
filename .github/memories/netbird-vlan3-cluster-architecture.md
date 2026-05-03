---
title: NetBird In-Cluster Architecture — VLAN3 (10.10.0.x)
description: Current active NetBird deployment is in-cluster on VLAN3; private domain int.rlservers.com used for VPN-only services to solve browser DoH bypass.
---

# NetBird In-Cluster Architecture — VLAN3

## Current State (as of 2026-04-30)

The **active NetBird deployment is in-cluster** on the Talos K8s cluster running on VLAN3 (10.10.0.0/24).
The old standalone VM at 10.25.0.100 (VLAN2) is no longer the primary deployment.

### MetalLB IPs

| Service | IP | Purpose |
|---------|-----|---------|
| Traefik (ingress) | 10.10.0.200 | All HTTPS traffic |
| CoreDNS | 10.10.0.201 | Internal DNS server |
| NetBird management | 10.10.0.202 | Management API (direct) |
| NetBird signal | 10.10.0.203 | Signal service |
| NetBird relay | 10.10.0.204 | Relay service |

### Traefik Routes (via 10.10.0.200)

| Path/Host | Backend | Middleware |
|-----------|---------|-----------|
| `netbird.rlservers.com` / | NetBird dashboard | `netbird-vpn-only` |
| `/management.ManagementService` | management:8080 | none |
| `/signalexchange.SignalExchange` | signal:10000 | none |
| `/relay*` | relay:33080 | none |
| `/api*` | management:8080 | none |

### Authentication
- **No SSO/IDP configured** — web OAuth login does NOT work
- Must always use: `netbird up --management-url https://netbird.rlservers.com --setup-key <KEY>`
- Setup key: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
- PAT token stored in OpenBao at path `netbird/pat-token`

---

## Private Domain: int.rlservers.com (added 2026-04-30)

### Problem: Browser DoH Bypasses NetBird Split-DNS

**Root cause of 403 despite being connected to NetBird:**
- Chrome/Edge have built-in DoH resolvers (Cloudflare 1.1.1.1, Google 8.8.8.8)
- These **bypass Windows NRPT rules** that NetBird installs for `rlservers.com` domain routing
- `netbird.rlservers.com` resolves via DoH to Cloudflare CDN IPs (188.114.96.x) — NOT to 10.10.0.200
- Traffic flows: Browser → Cloudflare CDN → origin → Traefik sees Cloudflare IP → blocked → **403**

### Solution: *.int.rlservers.com Private Subdomain

**Architecture:**
- Cloudflare DNS-only (grey cloud) wildcard: `*.int.rlservers.com → 10.10.0.200`
- `10.10.0.200` is a **private IP** — unreachable from the public internet without VPN
- Even if DoH resolves `netbird.int.rlservers.com → 10.10.0.200`, the TCP connection fails without VPN route
- VPN-connected users have `10.10.0.0/24 via wt0` → can reach 10.10.0.200

**VPN-only service URLs (use these instead of rlservers.com for private services):**

| Service | URL | Notes |
|---------|-----|-------|
| NetBird | `https://netbird.int.rlservers.com` | VPN or VLAN3 only |
| ArgoCD | `https://argocd.int.rlservers.com` | VPN or VLAN3 only |
| Grafana | `https://grafana.int.rlservers.com` | VPN or VLAN3 only |
| Longhorn | `https://longhorn.int.rlservers.com` | VPN or VLAN3 only |
| OpenBao | `https://openbao.int.rlservers.com` | VPN or VLAN3 only |

**TLS:** `int-rlservers-com-tls` secret — wildcard cert via `letsencrypt-cloudflare` (DNS-01), valid to Jul 29 2026.

### IngressRoutes (10-routes-vpn-only.yaml)
All routes use `netbird-vpn-only` middleware as defense-in-depth.
Explicitly reference `int-rlservers-com-tls` secret for TLS.

---

## Critical: NetBird DNS Nameserver Groups

The bootstrap job creates THREE nameserver groups. All are required:

| Name | DNS Server | Domain | Purpose |
|------|-----------|--------|---------|
| `prod-local` | 10.10.0.201 | `prod.local` | Internal K8s services |
| `rlservers-com` | 10.10.0.201 | `rlservers.com` | **Bypass Cloudflare CDN** |
| `int-rlservers-com` | 10.10.0.201 | `int.rlservers.com` | VPN-only private subdomain |

### Why `rlservers-com` Group is CRITICAL

**Problem:** `*.rlservers.com` is proxied through Cloudflare (IPs 188.114.96.0/20).
- Without this DNS group, connected VPN clients still resolve `netbird.rlservers.com` → `188.114.96.x` (Cloudflare CDN)
- Traffic goes: client → Cloudflare → origin (router NAT) → Traefik
- Traefik sees Cloudflare IP as source → blocked by `netbird-vpn-only` middleware → **403 Forbidden**
- This happens EVEN WHEN THE USER IS CONNECTED TO NETBIRD

**Fix:** `rlservers-com` nameserver group routes DNS for `rlservers.com` to `10.10.0.201`
- `10.10.0.201` (CoreDNS) resolves `*.rlservers.com` → `10.10.0.200` (Traefik)
- Traffic goes: client → VPN tunnel → 10.10.0.200 (Traefik)  
- Traefik sees 10.10.x.x source → in allowlist → **200 OK**

### CoreDNS Zone for rlservers.com
The `dns-system/coredns` ConfigMap has a static zone that returns `10.10.0.200` for all `*.rlservers.com`:
```
rlservers.com:53 {
    errors
    forward . 10.96.201.123  # forwards to kube-system CoreDNS which has the zone
    cache 30
}
```

Test: `dig @10.10.0.201 netbird.rlservers.com +short` → should return `10.10.0.200`

---

## VPN Access Security Model

### `netbird-vpn-only` Middleware (01-middlewares.yaml)
```yaml
sourceRange:
  - "100.64.0.0/10"    # NetBird CGNAT (direct WireGuard)
  - "10.244.0.0/16"    # K8s pod CIDR (flannel)
  - "10.10.0.0/24"     # VLAN3 nodes (masqueraded VPN traffic)
```

### Route Advertisement
- Bootstrap inserts routes: `10.10.0.0/24` and `10.25.0.0/24` (both with masquerade=1)
- NetBird client DaemonSet runs on all nodes with `hostNetwork: true`
- Masquerade replaces VPN source IP with node's VLAN3 IP (10.10.0.90-92)
- Traefik sees `10.10.0.9x` → in `10.10.0.0/24` allowlist → allowed

### What is Protected vs Public
| Service | Accessible from VPN? | Accessible from VLAN3 (10.10.x)? | Accessible from internet? |
|---------|---------------------|-------------------------------|--------------------------|
| test.rlservers.com | ✅ | ✅ | ✅ |
| netbird.rlservers.com | ✅ (with DNS group) | ❌ 403 from non-VLAN3 | ❌ 403 |
| netbird.int.rlservers.com | ✅ (private IP) | ✅ | ❌ (IP unreachable) |
| argocd.int.rlservers.com | ✅ (private IP) | ✅ | ❌ (IP unreachable) |
| NetBird management gRPC | ✅ | ✅ | ✅ (needed for initial connect) |

---

## Bootstrap Job Notes

**File:** `kubernetes/platform/netbird/manifests/bootstrap-job.yaml`

The bootstrap job runs as a K8s Job and configures the NetBird SQLite DB directly + via API.

Key operations:
1. Creates account, users, groups via SQLite
2. Creates setup key via SQLite
3. Creates PAT token via SQLite  
4. Inserts routes (10.10.0.0/24, 10.25.0.0/24) with masquerade via SQLite
5. Creates `prod-local` DNS nameserver group via REST API
6. Creates `rlservers-com` DNS nameserver group via REST API
7. Creates `int-rlservers-com` DNS nameserver group via REST API (added 2026-04-30)

**Important:** Steps 5-7 use the NetBird REST API (not SQLite directly) because nameserver groups have complex JSON that is hard to maintain in raw SQL.

---

## Nodes (VLAN3)

| Node | IP | VM ID | MAC |
|------|-----|-------|-----|
| cp1 | 10.10.0.90 | 9310 | BC:24:11:10:10:90 |
| cp2 | 10.10.0.91 | 9311 | BC:24:11:10:10:91 |
| cp3 | 10.10.0.92 | 9312 | BC:24:11:10:10:92 |

Gateway: 10.10.0.1  
Network: VLAN tag 3 on vmbr0  
Runner eth1: 10.10.0.108 (management VM on VLAN3)

---

## Lesson Learned

**If a user says "I'm connected to NetBird but still get 403":**
1. For `*.rlservers.com` URLs: check if the `rlservers-com` DNS group exists and the user doesn't have browser DoH enabled (which bypasses NRPT rules). Suggest using `*.int.rlservers.com` URLs instead.
2. For `*.int.rlservers.com` URLs: should work if VPN is connected (private IP is the access control).
3. Check Traefik access logs: `kubectl logs -n traefik deploy/traefik | grep -i "403\|forbidden"`
4. If source IP in logs is `172.70.x.x` or `188.114.x.x` → Cloudflare CDN → DoH bypass issue

**Immediate user fix for browser DoH bypass:**
- Chrome: `chrome://settings/security` → "Use secure DNS" → Off
- Or: just use `*.int.rlservers.com` URLs which work regardless of DoH
