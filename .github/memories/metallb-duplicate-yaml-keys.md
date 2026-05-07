---
title: MetalLB values.yaml — Duplicate YAML keys silently drop ignoreExcludeLB
description: Duplicate speaker/controller YAML keys caused MetalLB L2 to stop announcing on K8s 1.33+ control-plane-only clusters
---

# MetalLB Duplicate YAML Keys — Critical Failure Pattern

## Memory

- **File path:** `kubernetes/core/metallb/values.yaml`
- **Cluster impact:** ALL LoadBalancer IPs unreachable → everything external broken (NetBird, all services)

## What Happened

The values.yaml had duplicate top-level keys:
```yaml
# First speaker: block (frr disabled, ignoreExcludeLB set)
speaker:
  frr:
    enabled: false
  ignoreExcludeLB: true

# ... other keys ...

# Second speaker: block (overwrites ENTIRE first block)
speaker:
  priorityClassName: platform-critical
```

In YAML, duplicate keys at the same level → **last value wins**. The second `speaker:` block completely replaced the first. Result:
- `frr.enabled: false` → GONE → MetalLB defaulted to FRR/BGP mode (4 containers per speaker pod)
- `ignoreExcludeLB: true` → GONE → MetalLB saw the K8s 1.33+ `node.kubernetes.io/exclude-from-external-load-balancers` label on ALL control-plane nodes and refused to announce any IPs

Same issue with `controller:` block (resources were dropped).

## Why It Matters

On Kubernetes 1.33+, all control-plane nodes automatically get:
```
node.kubernetes.io/exclude-from-external-load-balancers
```
On a **control-plane-only cluster** (no worker nodes), this affects ALL nodes. MetalLB L2 mode refuses to announce IPs from nodes with this label unless `ignoreExcludeLB: true`.

**Symptom:** MetalLB speaker pods Running, IPs allocated, but NO ARP response for 10.10.0.200-210 → all LB IPs unreachable.

**Diagnostic commands:**
```bash
# ARP check — FAILED = MetalLB not announcing
ip neigh show | grep "10.10.0.200"  # should be REACHABLE

# NodePort test — bypasses MetalLB
nc -zv 10.10.0.92 30781  # Traefik HTTPS NodePort

# Speaker container count — FRR mode = 4 containers, native = 1
kubectl get pods -n metallb-system -o jsonpath='{.items[0].spec.containers[*].name}'
```

## Fix

Merge all duplicate keys into single YAML blocks:
```yaml
controller:
  priorityClassName: platform-critical
  resources: ...

speaker:
  priorityClassName: platform-critical
  frr:
    enabled: false
  ignoreExcludeLB: true  # CRITICAL for K8s 1.33+ control-plane-only clusters
```

## Related
- `kubernetes/core/metallb/values.yaml` — the fixed file
- MetalLB L2Advertisement: `kubernetes/core/metallb/manifests/l2advertisement.yaml`
- All LoadBalancer services: `kubectl get svc -A --field-selector spec.type=LoadBalancer`

## Lesson Learned
**Always lint YAML for duplicate keys** before committing. YAML parsers silently accept duplicates but behavior is undefined. Add `yamllint` or `yq` duplicate-key check to CI pipeline.
