---
title: VM Traefik to K8s Migration — Lessons Learned
description: Key gotchas and patterns from migrating all routing from an external Traefik VM to the Kubernetes-hosted Traefik (MetalLB).
---

# VM Traefik to K8s Migration — Lessons Learned

## Memory

- **File paths:**
  - `kubernetes/platform/external-routes/manifests/` — all IngressRoutes, middlewares, backends, certs
  - `kubernetes/core/traefik/values.yaml` — Traefik Helm config
  - `kubernetes/core/cert-manager/manifests/cluster-issuer.yaml` — ClusterIssuers
  - `kubernetes/platform/dns/manifests/configmap.yaml` — CoreDNS custom zone

---

## Critical Gotcha: Traefik Entrypoint-Level Redirect Blocks HTTP-01 ACME Challenges

**Problem:** Using `--entryPoints.web.http.redirections.entryPoint.to=websecure` in Traefik additionalArguments applies the redirect BEFORE any route matching. cert-manager HTTP-01 solver Ingresses (on port 80) never get to respond because the redirect intercepts all HTTP traffic first.

**Fix:** Remove the 3 `--entryPoints.web.http.redirections.*` args from traefik/values.yaml. Instead, add a catch-all HTTP IngressRoute on the `web` entrypoint with **priority: 1** that excludes `/.well-known/acme-challenge/`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: http-to-https-redirect
  namespace: traefik
spec:
  entryPoints:
    - web
  routes:
    - match: PathPrefix(`/`) && !PathPrefix(`/.well-known/acme-challenge/`)
      kind: Rule
      priority: 1
      middlewares:
        - name: redirect-to-https
          namespace: traefik
      services:
        - name: noop@internal
          kind: TraefikService
```

**Why it matters:** Without this, certificates can never be issued via HTTP-01.

---

## Critical Gotcha: Helm-Managed Ingresses on Port 80 Bypass HTTP Redirect

**Problem:** Helm charts for ArgoCD, Longhorn, OpenBao, Grafana, NetBird, etc. create `Ingress` objects that listen on ALL entrypoints (both `web` and `websecure`). These have specific host rules, so they have higher priority than our catch-all redirect IngressRoute. HTTP requests go directly to the backend instead of being redirected to HTTPS.

**Fix:** Add `traefik.ingress.kubernetes.io/router.entrypoints: websecure` annotation to ALL Helm-managed Ingresses. This restricts them to HTTPS only. The catch-all IngressRoute then handles all HTTP→HTTPS redirects.

**Files to update:** All `values.yaml` and custom `ingress-*.yaml` manifests for apps with Ingress objects.

---

## Critical Gotcha: Cluster CoreDNS Doesn't Forward Internal Zones

**Problem:** cert-manager uses cluster DNS (kube-system CoreDNS at 10.96.0.10) for HTTP-01 self-checks. The cluster CoreDNS uses `forward . /etc/resolv.conf` which may forward to external resolvers, not our internal CoreDNS at 10.25.0.201. Result: `rlservers.com` subdomains get NXDOMAIN from cert-manager's perspective.

**Fix:** Patch kube-system CoreDNS configmap to add explicit forward blocks:
```
rlservers.com:53 {
    errors
    forward . 10.25.0.201
    cache 30
}
prod.local:53 {
    errors
    forward . 10.25.0.201
    cache 30
}
```
Also restart CoreDNS: `kubectl rollout restart deployment/coredns -n kube-system`

**Persistence:** This must be in the full-redeploy workflow (step "Patch cluster CoreDNS for internal zones") because k3s/Talos reinstalls kube-system CoreDNS on fresh deploys.

---

## Cloudflare-Proxied Domains Require DNS-01, Not HTTP-01

**Problem:** Domains behind Cloudflare orange-cloud proxy (e.g., `yonavaarwater.nl`, `zonnevaarwater.nl`) resolve to Cloudflare IPs. When cert-manager does HTTP-01 self-checks, the request goes through Cloudflare and returns 404 even when our origin correctly handles the challenge. Domains with direct A records (e.g., `waterdance.nl`) work fine with HTTP-01.

**Detection:** Check if cert-manager self-check response has `Server: cloudflare` header.

**Fix:** Use a separate ClusterIssuer (`letsencrypt-cloudflare`) with DNS-01 solver via Cloudflare API token for these domains. Keep HTTP-01 issuer for non-proxied domains.

---

## Wildcard Certs Not Possible with HTTP-01

**Problem:** Wildcard certs (e.g., `*.rlservers.com`) require DNS-01 — HTTP-01 cannot validate wildcards. If you switch from DNS-01 to HTTP-01, you must replace wildcards with explicit per-subdomain SANs.

**Fix:** List all subdomains explicitly in the Certificate object. 35 SANs is fine for rlservers.com.

**Constraint:** Only publicly resolvable domains can be in a LE cert. Internal-only subdomains (e.g., `www.degoudentijd.rlservers.com` with no public DNS) cause `urn:ietf:params:acme:error:dns: NXDOMAIN` and must be removed from SANs.

---

## ArgoCD Endpoints Exclusion Must Be Removed

ArgoCD by default excludes `Endpoints` and `EndpointSlice` from management. If you use manual Endpoints objects (for bare-metal backends in external-routes), ArgoCD sync fails.

**Fix in argocd/values.yaml:**
```yaml
configs:
  cm:
    resource.exclusions: |
      - apiGroups:
        - coordination.k8s.io
        kinds:
        - Lease
      # Endpoints/EndpointSlice intentionally NOT excluded
```

---

## Traefik ExternalName Services Requirements

In Traefik v3 Helm chart (via CRD provider), you must set:
```yaml
providers:
  kubernetesCRD:
    allowExternalNameServices: true
    allowCrossNamespace: true
  kubernetesIngress:
    allowExternalNameServices: true
```
Without `allowExternalNameServices: true`, ExternalName routes silently fail with no error.

---

## Backend IP Verification Before Deployment

Always verify bare-metal backend IPs against actual Proxmox LXC/VM status:
- `bm-wp-yonava` (yonavaarwater.nl): CT 702 = 10.25.0.191 (NOT 10.25.0.187)
- `bm-degoudentijd` (degoudentijd.rlservers.com): CT 705 = 10.25.0.24 (NOT 10.25.0.19)

Quick check: `curl -sv --connect-timeout 3 http://<ip>/ 2>&1 | grep "< HTTP"`

---

## DNS Architecture

- Internal DNS server: custom CoreDNS in `dns-system` namespace, exposed via MetalLB at **10.25.0.201**
- `rlservers.com.hosts` zone handles all homelab subdomains; catch-all forwards to 1.1.1.1/8.8.8.8
- External domains (yonavaarwater.nl etc.) resolve via Cloudflare public DNS — no internal override needed
- ALL `rlservers.com` subdomains point to K8s Traefik at **10.25.0.200** in the CoreDNS zone

## Related
- `kubernetes/core/traefik/values.yaml`
- `kubernetes/platform/external-routes/manifests/01-middlewares.yaml` (catch-all redirect IngressRoute)
- `kubernetes/core/cert-manager/manifests/cluster-issuer.yaml`
- `.github/workflows/full-redeploy.yml` (CoreDNS patch step)

## NetBird-only Middleware: IP Routing Deep Dive

### netbird-vpn-only Middleware Purpose
Block local LAN users (10.25.0.x) from dashboard while allowing NetBird VPN clients.

### Why node IPs (10.25.0.90-92) don't work alone
NetBird masquerade=true transforms VPN peer IPs through multiple NAT layers:
1. **Same node as Traefik (hairpin NAT)**: source = CNI bridge IP (10.244.x.1)
2. **Cross-node via flannel VXLAN**: source = flannel VTEP IP (10.244.x.0)  
   NOT the node LAN IP (10.25.0.90-92) as naively expected

### Final allow list in netbird-vpn-only
```
100.64.0.0/10  # Direct WireGuard peers (no masquerade)
10.244.0.0/16  # K8s pod CIDR — covers all masquerade paths (hairpin + flannel)
```
Local LAN IPs (10.25.0.x) → 403 Forbidden ✓

### Ingress conflict pitfall
netbird-management Ingress had `netbird.rlservers.com` with `netbird-only` (allows LAN).
Fix: remove that host from Ingress — only IngressRoutes in `09-routes-netbird.yaml` handle it.

### Key: externalTrafficPolicy: Local
Traefik service has `externalTrafficPolicy: Local` — MetalLB announces 10.25.0.200 only
from the node where Traefik is running. External traffic source IPs are preserved for 
cross-node flows, but within-cluster traffic still gets kube-proxy SNAT.
