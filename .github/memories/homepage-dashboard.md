---
title: Homepage Dashboard — Homelab service hub at home.rlservers.com
description: jameswynn/homepage Helm chart showing all services with health status; VPN-only access.
---

# Homepage Dashboard

## Architecture

- **Chart:** `jameswynn/homepage` v1.* from `https://jameswynn.github.io/helm-charts`
- **Namespace:** `apps-homepage`
- **URL:** `https://home.rlservers.com`
- **Access:** VPN-only (`internal-only` Traefik middleware — LAN + NetBird VPN)

## Key Files

| File | Purpose |
|------|---------|
| `kubernetes/apps/homepage/application.yaml` | ArgoCD ApplicationSet entry |
| `kubernetes/apps/homepage/values.yaml` | All service config, health pings, theme |
| `kubernetes/apps/external-routes/manifests/12-routes-homepage.yaml` | Traefik IngressRoute with `internal-only` middleware |
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

**Why not `netbird-vpn-only`:** That middleware only allows 10.10.0.10/32 (routing peer masquerade), which would block LAN users. `internal-only` allows both LAN and VPN access.

## DNS

`home.rlservers.com → 10.10.0.200` is configured in:
- `kubernetes/apps/dns/manifests/configmap.yaml` → `rlservers.com.hosts` section
- Required so cert-manager HTTP-01 self-check (runs from inside cluster) can resolve the domain

## TLS

Uses `rlservers-com-wildcard-tls` (default TLS store) via `tls: {}` in IngressRoute.  
Cloudflare SSL mode Full means outer TLS is handled by Cloudflare edge cert; origin cert is the wildcard.

## Email Link

Deployment email always includes a link to `https://home.rlservers.com` with a "🔒 Requires NetBird VPN" notice.

## Adding New Services

1. Add an entry to `kubernetes/apps/homepage/values.yaml` under the appropriate group
2. Use internal K8s DNS for `href` ping (not the public URL) for reliable health checks
3. Push to `main` — ArgoCD syncs automatically
