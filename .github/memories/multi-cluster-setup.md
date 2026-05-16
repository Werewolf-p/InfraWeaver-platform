---
title: Multi-Cluster Support — Setup & Architecture
description: How to configure and use multi-cluster support in the InfraWeaver console
---

# Multi-Cluster Support

## Memory

### Architecture
- **Active cluster** is stored in an HMAC-signed HTTP-only cookie `infraweaver-cluster`
- **Cluster list** comes from `CLUSTER_CONTEXTS` env var (JSON array of `ClusterConfig`)
- **Single cluster mode**: No `CLUSTER_CONTEXTS` set → defaults to `{id:"default", displayName: from CLUSTER_DISPLAY_NAME env}`
- **React context** (`src/contexts/cluster-context.tsx`) syncs with the cookie on every `setActiveId` call
- **API routes** call `getRequestClusterId(request)` → `loadKubeConfig(clusterId)` per request

### ClusterConfig Type
```typescript
{
  id: string;           // URL-safe identifier, e.g. "homelab-prod"
  displayName: string;  // Human name shown in dropdown
  description?: string;
  tags?: string[];
  isLocal?: boolean;    // true = use in-cluster service account
  kubeconfig?: string;  // base64-encoded kubeconfig (remote clusters)
  argocdServer?: string;
  argocdToken?: string;
  gatusUrl?: string;    // Gatus health endpoint for this cluster
}
```

### Adding a Second Cluster
1. Get a kubeconfig for the remote cluster with sufficient permissions
2. base64-encode it: `base64 -w0 kubeconfig.yaml`
3. Set `CLUSTER_CONTEXTS` env var in console deployment (see deployment.yaml comments)
4. Redeploy console
5. Cluster appears in dropdown; console pings it to determine health status

### What Routes Are NOT Cluster-Aware (intentional)
- `/api/netbird/*` — NetBird is a global VPN overlay, single instance
- `/api/game-hub/*` — Game servers run on local cluster only
- `/api/health` — Uses per-cluster `gatusUrl` from ClusterConfig (IS cluster-aware)

### Mutations + "All Clusters"
Mutation routes return `400 { error: "Select a specific cluster before performing this action" }` when the active cluster cookie is `"all"`. This prevents accidental multi-cluster operations.

### File Paths
- `src/lib/cluster-context.ts` — Server lib: cookie + env var
- `src/contexts/cluster-context.tsx` — React context
- `src/components/layout/cluster-selector.tsx` — Dropdown UI
- `src/app/api/clusters/route.ts` — Lists clusters with health ping
- `src/app/api/clusters/active/route.ts` — GET/POST active cluster cookie

### Validation
```bash
# Check cluster list endpoint (should show all configured clusters with status)
curl -H "Cookie: infraweaver-session=..." https://infraweaver.int.rlservers.com/api/clusters

# Switch cluster
curl -X POST -H "Content-Type: application/json"   -d '{"clusterId":"homelab-dev"}'   https://infraweaver.int.rlservers.com/api/clusters/active
```
