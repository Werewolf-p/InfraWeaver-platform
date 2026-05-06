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
| Wiki | `wiki.int.rlservers.com` | catalog |
| Uptime Kuma | `uptime-kuma.int.rlservers.com` | catalog |
| Gitea | `gitea.int.rlservers.com` | catalog |
| Vaultwarden | `vaultwarden.int.rlservers.com` | catalog |

## DNS Configuration

Cloudflare DNS-only record (no proxy):
```
*.int.rlservers.com  A  10.10.0.200   (DNS-only, not proxied)
```

CoreDNS custom zone for in-cluster resolution:
```
# kubernetes/platform/dns/manifests/configmap.yaml → int.rlservers.com.hosts
10.10.0.200  int.rlservers.com
10.10.0.200  netbird.int.rlservers.com
... (explicit entries for known services)
```

**IMPORTANT: CoreDNS Wildcard Template (added May 2026)**

The `int.rlservers.com:53` zone also uses a `template` plugin for wildcard resolution:
```
template IN A int.rlservers.com {
    match "^(.*)\\.int\\.rlservers\\.com\\.$"
    answer "{{ .Name }} 60 IN A 10.10.0.200"
    fallthrough
}
```

This means ALL `*.int.rlservers.com` subdomains resolve to `10.10.0.200` via CoreDNS, even if not explicitly listed in the hosts file. **New catalog apps do NOT require adding a hosts-file entry.**

**Why this matters:**  
Without the template plugin, the `hosts` plugin's `fallthrough` passes unmatched queries to `log`/`errors` (no forwarder in zone), returning **NXDOMAIN**. NetBird DNS routing sends `int.rlservers.com` queries to CoreDNS — so phone/laptop clients get `ERR_NAME_NOT_RESOLVED` for any app not in the hosts file.

## Middleware: netbird-vpn-only

Allows `10.10.0.0/24` — the entire VLAN3 subnet where K8s nodes (10.10.0.90-92) run.  
NetBird DaemonSet pods on these nodes masquerade VPN client traffic (SNAT) → Traefik sees source = K8s node VLAN3 IP.  
Also allows `100.64.0.0/10` (NetBird CGNAT, direct WireGuard peers) and `10.244.0.0/16` (pod CIDR).  
**Never use `internal-only` for `.int.` routes** — those are exclusively VPN.

Defined in: `kubernetes/platform/external-routes/manifests/01-middlewares.yaml`

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
2. ~~Add DNS entry to `configmap.yaml`~~ → **NOT REQUIRED** (wildcard template handles it)
3. No cert changes needed — wildcard covers all `*.int.rlservers.com`

## Lesson Learned (May 2026)

**Bug:** CoreDNS `int.rlservers.com:53` zone used `fallthrough` in `hosts` plugin but had no `forward` plugin after it. Unmatched subdomains returned NXDOMAIN via NetBird DNS routing.  
**Symptom:** Phone (and all NetBird clients) got `ERR_NAME_NOT_RESOLVED` for `wiki.int.rlservers.com` and all catalog apps.  
**Fix:** Added `template IN A int.rlservers.com` with regex `^(.*)\\.int\\.rlservers\\.com\\.$` → answers `10.10.0.200`.  
**File:** `kubernetes/platform/dns/manifests/configmap.yaml`
