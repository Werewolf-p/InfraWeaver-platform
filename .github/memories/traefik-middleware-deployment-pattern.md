---
title: Traefik Middleware Must Be Deployed via manifests/ + Bootstrap Application
description: Raw Kubernetes manifests in core/traefik/ are NOT deployed by the Helm ApplicationSet — they need a dedicated bootstrap Application.
---

# Traefik Middleware Deployment Pattern

## Memory

- **File paths:**
  - `kubernetes/core/traefik/manifests/middleware-netbird.yaml` — Traefik IPAllowList Middleware CRD
  - `kubernetes/bootstrap/app-traefik-manifests.yaml` — ArgoCD Application that deploys the manifests
- **Decision:** The ApplicationSet (applicationset-root.yaml) only processes Helm charts via `application.yaml` files. Raw YAML manifests in `core/traefik/` are silently ignored. A dedicated bootstrap Application (applied via `kubectl apply` in the platform.yml workflow loop) is required to deploy them.
- **Why it matters:** If the Middleware CRD doesn't exist in the cluster, Traefik silently ignores `traefik.ingress.kubernetes.io/router.middlewares` annotations on Ingress resources. ArgoCD, Grafana, and Longhorn will be publicly accessible to anyone who can route to the MetalLB IP (10.25.0.200), even though the annotations are present in values.yaml.
- **Validation:** `kubectl get middleware -n traefik` — must show `netbird-only`. If empty, the middleware is not deployed regardless of ingress annotations.
- **Related:** `kubernetes/bootstrap/app-longhorn-manifests.yaml` — same pattern for Longhorn extra StorageClasses
- **Lesson learned:** Raw manifests co-located with a Helm app's `application.yaml` are NOT automatically applied. Always create a `manifests/` subdir and a matching bootstrap Application.

## Protected Services (NetBird-only)

All these ingresses carry `traefik.ingress.kubernetes.io/router.middlewares: traefik-netbird-only@kubernetescrd`:

| Service | Namespace | Host |
|---------|-----------|------|
| ArgoCD | argocd | argocd.prod.local |
| Grafana (standalone) | apps-grafana | grafana.prod.local |
| Grafana (kube-prometheus-stack) | monitoring | grafana.prod.local |
| Longhorn | longhorn-system | longhorn.prod.local |
| NetBird in-cluster (INACTIVE) | netbird | netbird.prod.local |

**Public services (no middleware):**
- `test-website` → `test.prod.local` (intentionally public)

## IP Allowlist (middleware-netbird.yaml)

```yaml
spec:
  ipAllowList:
    sourceRange:
      - 100.64.0.0/10    # NetBird default CGNAT CIDR (direct WireGuard peers)
      - 10.64.0.0/10     # Alternative NetBird CIDR
      - 10.25.0.108/32   # github-runner routing peer — all NetBird LAN-route traffic appears as this IP
      - 127.0.0.1/32     # Localhost
```

**CRITICAL — Why 10.25.0.108/32 and NOT 10.25.0.0/24:**
NetBird peers access `*.prod.local` services via the LAN route (through the github-runner routing peer at 10.25.0.108).
The source IP Traefik sees for ALL NetBird-routed traffic is 10.25.0.108 (the routing peer's LAN IP), NOT the WireGuard IP.
Using /24 would allow all LAN clients regardless of NetBird. Using /32 ensures ONLY traffic routed through the NetBird peer is allowed.

## Prerequisite: externalTrafficPolicy: Local

Traefik's Service must have `externalTrafficPolicy: Local` to preserve real client IPs through MetalLB L2. Without this, all source IPs appear as the node IP and the allowlist won't work correctly.

Verify: `kubectl get svc traefik -n traefik -o jsonpath='{.spec.externalTrafficPolicy}'` → must be `Local`

## netbird.rlservers.com DNS — MUST point to 10.25.0.5, not 10.25.0.100

**LESSON LEARNED:** The internal CoreDNS was pointing `netbird.rlservers.com` → `10.25.0.100` (VM directly).
Port 443 is NOT open on the NetBird VM — standalone Traefik at `10.25.0.5` is the TLS terminator with the Let's Encrypt cert.
Internal clients (on LAN or NetBird split-DNS) were getting "Connection refused" on port 443 → NetBird client "failed to connect".

**Fix:** CoreDNS configmap (`kubernetes/platform/dns/manifests/configmap.yaml`) must have:
```
10.25.0.5   netbird.rlservers.com
```
NOT:
```
10.25.0.100 netbird.rlservers.com   ← WRONG — 443 refused on VM
```
