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
- **Query param override**: `?clusterId=X` in any API route overrides the cookie (used by ClusterSummaryCard for per-cluster stats fetching)

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
6. "All Clusters" option appears in the dropdown when 2+ clusters are configured

### What Routes Are NOT Cluster-Aware (intentional)
- `/api/netbird/*` — NetBird is a global VPN overlay, single instance
- `/api/game-hub/*` — Game servers run on local cluster only
- `/api/health` — Uses per-cluster `gatusUrl` from ClusterConfig (IS cluster-aware)

### Mutations + "All Clusters"
When `activeId === "all"` in React, the HTTP cookie retains the last selected specific
cluster value. Mutations continue to target that last cluster. The cluster context
banner in the layout tells the user to select a specific cluster.
Mutation routes can add an explicit check: if `clusterId === "all"` return 400.

### UI Components
- **Topbar** (`src/components/layout/topbar.tsx`): ClusterSelector always visible (hidden md on mobile)
- **Mobile drawer**: ClusterSelector shown in footer when 2+ clusters configured
- **Cluster context banner** in `layout.tsx`: Shown when non-primary cluster or "all" is active
- **ClusterSummaryCard**: Shows per-cluster app/pod counts by fetching with `?clusterId=`
- **Home page**: Shows `ClusterSummaryCard` grid when `activeId === "all"`

### Fallback Behavior
- Stored cluster ID not in configured list → fall back to `clusters[0].id` (first available)
- Invalid/missing cookie → fall back to `getDefaultClusterId()` (cluster with id="default" or first)

### File Paths
- `src/lib/cluster-context.ts` — Server lib: cookie parsing, getRequestClusterId (with ?clusterId= support)
- `src/contexts/cluster-context.tsx` — React context with fallback logic
- `src/components/layout/cluster-selector.tsx` — Dropdown UI with status dots
- `src/components/ui/cluster-summary-card.tsx` — Per-cluster stats card
- `src/app/api/clusters/route.ts` — Lists clusters with health ping
- `src/app/api/clusters/active/route.ts` — GET/POST active cluster cookie

### Validation
```bash
# Check cluster list endpoint (should show all configured clusters with status)
curl -H "Cookie: infraweaver-session=..." https://infraweaver.int.rlservers.com/api/clusters

# Switch cluster
curl -X POST -H "Content-Type: application/json" \
  -d '{"clusterId":"homelab-dev"}' \
  https://infraweaver.int.rlservers.com/api/clusters/active

# Fetch apps for a specific cluster (query param override)
curl "https://infraweaver.int.rlservers.com/api/argocd/apps?clusterId=homelab-dev"
```
