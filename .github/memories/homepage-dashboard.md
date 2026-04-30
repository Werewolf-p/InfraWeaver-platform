---
title: Homepage Dashboard — Homelab service hub at home.rlservers.com
description: jameswynn/homepage Helm chart showing all services with health status; VPN-only access.
---

# Homepage Dashboard

## Architecture

- **Chart:** `jameswynn/homepage` v1.* from `https://jameswynn.github.io/helm-charts`
- **Namespace:** `apps-homepage`
- **URL:** `https://home.int.rlservers.com`
- **Access:** VPN-only (`netbird-vpn-only` Traefik middleware — NetBird routing peer only)

## Key Files

| File | Purpose |
|------|---------|
| `kubernetes/apps/homepage/application.yaml` | ArgoCD ApplicationSet entry |
| `kubernetes/apps/homepage/values.yaml` | All service config, health pings, theme |
| `kubernetes/apps/external-routes/manifests/12-routes-homepage.yaml` | Traefik IngressRoute with `netbird-vpn-only` middleware |
| `kubernetes/apps/external-routes/manifests/04-backends-cluster.yaml` | ExternalName Service for cross-namespace Traefik routing |

## Health Ping Design

Health checks use internal K8s DNS (`http://<service>.<namespace>.svc.cluster.local`) so:
- VPN-only services (behind `netbird-vpn-only` middleware) are still reachable from the homepage pod
- No Traefik middleware IP restrictions apply to in-cluster pod traffic

## Access Restriction

The `internal-only` middleware (`kubernetes/apps/external-routes/manifests/01-middlewares.yaml`) allows:
- `10.25.0.0/24` — Proxmox management VLAN
- `10.10.0.0/24` — Kubernetes VLAN3 (includes NetBird routing peer at 10.10.0.10)
- `100.64.0.0/10` — NetBird direct CGNAT range (peer-to-peer VPN mode)
- `127.0.0.1/32`, `172.25.0.0/16` — localhost + Docker

**Why `netbird-vpn-only` (not `internal-only`):** Homepage is at `home.int.rlservers.com` — exclusively VPN-only. The `netbird-vpn-only` middleware allows only 10.10.0.10/32 (NetBird routing peer masquerade IP). All access must go through NetBird VPN.

## DNS

`home.int.rlservers.com → 10.10.0.200` is configured in:
- `kubernetes/apps/dns/manifests/configmap.yaml` → `int.rlservers.com.hosts` section
- Cloudflare DNS-only record (no proxy) pointing to private IP 10.10.0.200

## TLS

Uses `int-rlservers-com-tls` (`int-rlservers-com-wildcard` certificate, DNS-01 via Cloudflare).  
Secret name: `int-rlservers-com-tls` in `traefik` namespace.

## Email Link

Deployment email always includes a link to `https://home.int.rlservers.com` with a "🔒 Requires NetBird VPN" notice.

## Adding New Services

1. Add an entry to `kubernetes/apps/homepage/values.yaml` under the appropriate group
2. Use internal K8s DNS for `href` ping (not the public URL) for reliable health checks
3. Push to `main` — ArgoCD syncs automatically
