---
title: etcd CORRUPT alarm after fresh Talos cluster deployment
description: Fresh Talos clusters can trigger etcdserver corrupt cluster alarm, causing write failures
---

# etcd CORRUPT alarm on fresh Talos cluster

## Memory

- **When it happens:** After a fresh Talos cluster deployment, one or more etcd members may raise a CORRUPT alarm. MetalLB, ArgoCD, and other controllers will fail with `etcdserver: corrupt cluster` errors.
- **Root cause:** etcd's consistency checker detected a hash mismatch between members during the initial data sync. Usually a false positive after bootstrap, not real data corruption.
- **Symptoms:** MetalLB VIPs not reachable (speakers can't update L2 status), ArgoCD shows "Unknown" for all apps, pod creation returns "etcdserver: corrupt cluster"

## Fix

```bash
TALOSCONFIG="envs/productie/generated/talosconfig"

# 1. Check which member has the alarm
talosctl --talosconfig "$TALOSCONFIG" \
  --nodes 10.10.0.90,10.10.0.91,10.10.0.92 --endpoints 10.10.0.90 \
  etcd status

# 2. Disarm alarm on ALL nodes
for node in 10.10.0.90 10.10.0.91 10.10.0.92; do
  talosctl --talosconfig "$TALOSCONFIG" \
    --nodes "$node" --endpoints "$node" \
    etcd alarm disarm
done

# 3. Defrag etcd (shrinks db, prevents future issues)
for node in 10.10.0.90 10.10.0.91 10.10.0.92; do
  talosctl --talosconfig "$TALOSCONFIG" \
    --nodes "$node" --endpoints "$node" \
    etcd defrag
done

# 4. Restart MetalLB speakers to re-announce VIPs
kubectl rollout restart ds/metallb-speaker -n metallb-system
```

## Why it matters

- MetalLB L2 VIPs become unreachable (Traefik, CoreDNS, NetBird management all offline)
- All Kubernetes write operations fail (pod creation, status updates)
- ArgoCD controllers can't sync
- Cloudflare returns 523 for public domains (can't reach origin)

## Validation

```bash
# No ERRORS column output = healthy
talosctl etcd status
# All ping 0% loss (MetalLB VIPs)
ping -c 3 10.10.0.200
```

## Related

- `envs/productie/generated/talosconfig` - required for talosctl
- MetalLB speakers restart automatically but need `rollout restart` to re-announce after alarm clear
- CSI sidecar pods (csi-attacher etc.) may need pod deletion to reset CrashLoopBackOff after recovery
