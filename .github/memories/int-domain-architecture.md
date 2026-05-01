---
title: Internal Domain Architecture — *.int.rlservers.com
description: All cluster-internal VPN-only apps use *.int.rlservers.com. External/public apps stay on *.rlservers.com.
---

# Internal Domain Architecture

## Rule: Public vs VPN-Only

| Domain Pattern | Access | Middleware | Cert |
|---------------|--------|------------|------|
| `*.rlservers.com` | Public internet | None / `auth-forward` | `rlservers-com-wildcard-tls` (HTTP-01) |
| `netbird.rlservers.com` | **Removed** (dashboard is now VPN-only at `netbird.int.rlservers.com`) | — | — |
| `auth.rlservers.com` | Public internet | None | `rlservers-com-wildcard-tls` (bundled) |
| `*.int.rlservers.com` | NetBird VPN only | `netbird-vpn-only` | `int-rlservers-com-tls` (DNS-01) |

## Internal Apps (*.int.rlservers.com)

All cluster-hosted apps that should NOT be publicly accessible:

| Service | URL | Route File |
|---------|-----|------------|
| Homepage dashboard | `home.int.rlservers.com` | `12-routes-homepage.yaml` |
| ArgoCD | `argocd.int.rlservers.com` | `10-routes-vpn-only.yaml` |
| Grafana | `grafana.int.rlservers.com` | `10-routes-vpn-only.yaml` |
| Longhorn | `longhorn.int.rlservers.com` | `10-routes-vpn-only.yaml` |
| OpenBao | `openbao.int.rlservers.com` | `10-routes-vpn-only.yaml` |
| NetBird (VPN alt) | `netbird.int.rlservers.com` | `10-routes-vpn-only.yaml` |

## DNS Configuration

Cloudflare DNS-only record (no proxy):
```
*.int.rlservers.com  A  10.10.0.200   (DNS-only, not proxied)
```

CoreDNS custom zone for in-cluster resolution:
```
# kubernetes/apps/dns/manifests/configmap.yaml → int.rlservers.com.hosts
10.10.0.200  int.rlservers.com
10.10.0.200  netbird.int.rlservers.com
10.10.0.200  argocd.int.rlservers.com
10.10.0.200  grafana.int.rlservers.com
10.10.0.200  home.int.rlservers.com
10.10.0.200  longhorn.int.rlservers.com
10.10.0.200  openbao.int.rlservers.com
```

## Middleware: netbird-vpn-only

Allows `10.10.0.0/24` — the entire VLAN3 subnet where K8s nodes (10.10.0.90-92) run.  
NetBird DaemonSet pods on these nodes masquerade VPN client traffic (SNAT) → Traefik sees source = K8s node VLAN3 IP.  
Also allows `100.64.0.0/10` (NetBird CGNAT, direct WireGuard peers) and `10.244.0.0/16` (pod CIDR).  
**Never use `internal-only` for `.int.` routes** — those are exclusively VPN.

Defined in: `kubernetes/apps/external-routes/manifests/01-middlewares.yaml`

## TLS Certificate

`int-rlservers-com-wildcard` Certificate in `traefik` namespace:
- Uses `letsencrypt-cloudflare` ClusterIssuer (DNS-01)
- DNS-01 required because Cloudflare record is DNS-only (private IP, HTTP-01 unreachable)
- Secret: `int-rlservers-com-tls`
- **Rate limit fix (April 2026):** Use ONLY `*.int.rlservers.com` (not apex) to avoid exhausting SAN sets

## Exceptions: Stays Public

- `netbird.rlservers.com` — VPN entry point; must be public for new client enrollment
- `auth.rlservers.com` — Authentik SSO; must be public for OAuth/OIDC flows (including NetBird)

## Adding New Internal App

1. Add Traefik IngressRoute to `10-routes-vpn-only.yaml` (or new file) with:
   - `host: <name>.int.rlservers.com`
   - `middlewares: netbird-vpn-only`
   - `tls.secretName: int-rlservers-com-tls`
2. Add DNS entry to `configmap.yaml` → `int.rlservers.com.hosts`
3. No cert changes needed — wildcard covers all `*.int.rlservers.com`
