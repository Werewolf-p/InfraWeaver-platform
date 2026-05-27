---
title: local-path PVCs only bind when a pod mounts them
description: local-path provisioner uses WaitForFirstConsumer binding; PVCs stay Pending until a pod is scheduled
---

# local-path PVC Binding Behavior

## Memory

- **Why it matters:** Defining a PVC with `storageClassName: local-path` when the associated Deployment has `replicas: 0` causes the PVC to remain `Pending` indefinitely. ArgoCD sees the Pending PVC as Progressing/Degraded, which cascades up to the parent app (bootstrap).

- **Decision:** Remove PVC from git manifest when the deployment is intentionally at `replicas: 0`. Re-add PVC when deployment is re-enabled. See `kubernetes/catalog/game-hub/servers/terraria.yaml` for example.

- **Node affinity:** local-path PVs get `nodeAffinity` pinned to the node where the first pod ran. If a node is upgraded/rebooted and the pod is rescheduled to a different node, the pod will be rescheduled back to the original node (Kubernetes honors the PV nodeAffinity). Pods on local-path storage survive node reboots correctly.

- **Lesson learned:** WaitForFirstConsumer vs Immediate binding mode — local-path uses WaitForFirstConsumer (deferred binding). Immediate mode (default for most storage classes) creates the PV immediately. local-path defers until pod is scheduled.
