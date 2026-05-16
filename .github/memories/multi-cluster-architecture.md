---
title: Multi-cluster architecture
description: Cookie-based cluster context switching for the InfraWeaver console
---

# Multi-cluster Architecture

## Memory

- Cluster definitions come from the `CLUSTER_CONTEXTS` environment variable as a JSON array.
- Each entry uses the `ClusterConfig` shape from `apps/infraweaver-console/src/lib/cluster-context.ts`:
  - `id`
  - `displayName`
  - optional base64 kubeconfig
  - optional `argocdServer`
  - optional `argocdToken`
- If `CLUSTER_CONTEXTS` is not set, the console falls back to a single `default` cluster using existing in-cluster / kubeconfig behavior.
- `cluster-context.ts` is the server-side factory for parsing cluster configs and resolving the default cluster.
- The active cluster is stored in an `infraweaver-cluster` httpOnly cookie with a 24 hour TTL.
- The cookie value is HMAC-signed so tampering falls back to the default cluster instead of trusting user input.
- `/api/clusters` returns only safe metadata (`id`, `displayName`) and never exposes kubeconfigs or tokens.
- `/api/clusters/active` reads and writes the active cluster cookie.
- `ClusterSelector` in `src/components/ui/cluster-selector.tsx` fetches the cluster list and current active cluster, updates the cookie, and calls `router.refresh()` after switching.
- API routes that need cluster-specific behavior should read the `infraweaver-cluster` cookie and pass the cluster ID into `loadKubeConfig(clusterId)` or other cluster-aware helpers.
- `loadKubeConfig(clusterId)` uses the configured base64 kubeconfig when present, otherwise it falls back to the existing in-cluster/default kubeconfig flow.
