# Community Apps — AppFeed Integration

## Overview
Browse and deploy 3,526+ Unraid community apps to Kubernetes via the InfraWeaver console.
Feed source: `https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json`

## Architecture

### Caching Strategy
- Feed is ~25MB and updates ~every 2h (tracked via GitHub commits API)
- Server-side cache: `fetch(..., { next: { revalidate: 7200 } })` — 2h cache
- Clients receive paginated slices (~24 apps per page, ~4KB per response)
- No per-user fetching of the full 25MB feed

### Conversion Engine (`src/lib/appfeed-converter.ts`)
Unraid `Config` types map to Kubernetes resources:

| Unraid Type | K8s Equivalent |
|-------------|---------------|
| `Variable`  | `env[].name/value` in Deployment |
| `Port`      | `containerPorts[]` + ClusterIP Service |
| `Path`      | `volumeMounts[]` + PersistentVolumeClaim (Longhorn, 10Gi default) |
| `Device`    | `securityContext.privileged: true` + tier=complex |
| `Network: host` | `hostNetwork: true` in PodSpec |

### Compatibility Tiers
- **simple (92%)**: standard Docker image, standard K8s Deployment — deploys directly
- **medium (3%)**: custom Docker network (not bridge/host/none) — informational note shown
- **complex (5%)**: Privileged=true or Device passthrough — warning required before deploy

### API Routes
- `GET /api/community-apps` — paginated/filtered list with `?page`, `?limit`, `?search`, `?category`, `?tier`
- `POST /api/community-apps/convert` — preview K8s YAML without deploying; rate-limited 30/min
- `POST /api/community-apps/deploy` — commit YAML to GitHub → ArgoCD auto-syncs; requires `catalog:write`; rate-limited 5/min

### Deploy Flow
1. User converts app → previews YAML in Monaco editor
2. User approves → POST /api/community-apps/deploy
3. Files committed to `kubernetes/catalog/<slug>/manifests/`:
   - `deployment.yaml` (Deployment + Service if ports exist)
   - `pvc.yaml` (if Path configs exist)
   - `ingressroute.yaml` (if WebUI port found)
   - `catalog.yaml` (ArgoCD Application resource)
4. ArgoCD auto-syncs within ~60s

### IngressRoute
- Default middleware: `netbird-vpn-only` (VPN-internal only)
- Host: auto-derived from `<slug>.int.rlservers.com`

## UI Location
`/community-apps` — App store grid with search, category pills, tier filter, deploy modal (3-step wizard)

## Security
- All deploy routes require `catalog:write` permission
- Rate limiting: convert 30/min, deploy 5/min
- All deploys are audit-logged
- Complex/privileged apps show explicit warning before deploy

## Commit
- Feature commit: `a7cbc57` (feat(community-apps): Unraid AppFeed browser + K8s converter)
- Image pinned at: `main-a7cbc57`
