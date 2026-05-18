---
title: MetalLB Speaker Init Container — Talos Linux API Server Quirks
description: On Talos, kube-apiserver only binds to node IP (not 127.0.0.1) and has --anonymous-auth=false. Both break common healthcheck patterns.
---

# MetalLB Speaker Init Container — Talos Linux API Server Quirks

## Memory

- **File paths:** `kubernetes/core/kyverno/manifests/metallb-speaker-wait-policy.yaml`
- **Decision:** Use `nc -z -w 5 <nodeIP> 6443` (TCP port check) in the MetalLB speaker init container instead of HTTP healthz
- **Why it matters:**
  - Two compounding Talos quirks broke the init container:
    1. kube-apiserver binds to the node's primary IP only — NOT `127.0.0.1:6443`. Using loopback causes the init container to loop forever even when the API server is healthy.
    2. Talos sets `--anonymous-auth=false` on the API server. So `/healthz` and `/readyz` return `401 Unauthorized`. busybox `wget --spider` treats 401 as a failure (non-zero exit code), so it never exits even when the server IS responding.
  - Root symptom: all 3 metallb-speaker pods stuck in `Init:0/1` → MetalLB stops advertising VIPs → Traefik LoadBalancer VIP `10.10.0.200` unreachable → container registry (`onedev.rlservers.com`) and all ingress-routed services go down → ALL CI builds fail with `dial tcp 10.10.0.200:443: connect: no route to host`
- **Validation:**
  - `kubectl get pods -n metallb-system` should show all 3 speakers `1/1 Running`
  - `curl -sk https://onedev.rlservers.com/v2/ -o /dev/null -w "%{http_code}"` should return `401` (up, auth required)
  - `curl -sk https://infraweaver.int.rlservers.com/api/ping -o /dev/null -w "%{http_code}"` should return `200`
- **Fix:** Get node IP from `hostname -I | awk '{print $1}'` (works because speaker pods use `hostNetwork: true`) and check TCP with `nc -z -w 5 <nodeIP> 6443`. No auth needed.
- **Related:** `kubernetes/core/metallb/application.yaml`, Kyverno ClusterPolicy, `.github/workflows/build-api.yml`, `.github/workflows/build-console.yml`
- **Lesson learned:**
  - NEVER use `127.0.0.1` in Talos-targeted init containers — the API server is NOT on loopback
  - NEVER use HTTP healthcheck endpoints on Talos API server without authentication — `--anonymous-auth=false`
  - If MetalLB speakers are stuck, check `kubectl logs -n metallb-system <speaker-pod> -c wait-for-apiserver`
  - TCP port check (`nc -z`) is the correct approach for Talos: reliable, auth-free, host-network-aware
