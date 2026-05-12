# Game Hub Architecture

## Overview
Game Hub is an addon that deploys game servers to the `game-hub` namespace via the InfraWeaver Console.

## RBAC — CRITICAL: Duplicate ClusterRole Bug (Fixed)
The `infraweaver-console-reader` ClusterRole was defined in TWO places:
- `manifests/rbac.yaml` — correct, full permissions including storageclasses
- `manifests/service-account.yaml` — OLD, incomplete permissions (no storageclasses)

ArgoCD applied BOTH files alphabetically, so `service-account.yaml` (applied last) **overwrote** the correct rules. **Fixed in commit `3fe5628`** by removing the duplicate from `service-account.yaml`.

**Always keep the ClusterRole definition ONLY in `rbac.yaml`.**

## Service Account Names
There are TWO service accounts in `infraweaver-console` namespace:
- `infraweaver-console` — used by the running pods (set in deployment spec)
- `infraweaver-console-sa` — older SA for token-based access (service-account.yaml)

All RBAC (ClusterRoleBinding, game-hub RoleBinding) must reference `infraweaver-console`.

## Registry
Always use: `onedev.rlservers.com/infraweaver/infraweaver-console:main-{sha}`
Container name in deployment: `console` (not `infraweaver-console`)
**NOT ghcr.io** — that's wrong.

## Console Log Streaming (SSE)
- Endpoint: `/api/game-hub/servers/[name]/logs`
- Uses `k8s.Log` class with `PassThrough` stream
- SSE format: `data: {json}\n\n`
- Set `X-Accel-Buffering: no` header to prevent Traefik from buffering
- Frontend uses `EventSource` API

## File Manager
- List: `/api/game-hub/servers/[name]/files`
- Read/Write: `/api/game-hub/servers/[name]/files/content`
- Files written via base64: `echo "${b64}" | base64 -d > "${file}"` (safe for special chars)
- 5MB size limit on reads

## Egg System
- 19 built-in eggs in `src/lib/game-eggs.ts`
- Served via `/api/game-hub/eggs`
- Each egg: `id`, `name`, `image`, `ports[]`, `mountPath`, `pvcSuffix`, `envVars[]`
- Valheim uses `pvcSuffix: "config"` and 3 ports (2456 UDP, 2457 UDP, 2458 TCP)

## K8s Events API
- Endpoint: `/api/k8s/events?namespace=game-hub&name={podName}`
- Filters by `involvedObject.name` field selector
- Returns last 50 events sorted by timestamp

## Game Servers Namespace
- Namespace: `game-hub`
- Deployment label: `infraweaver/game=true`
- Test servers: minecraft-server, terraria-server, valheim-server

## ArgoCD Sync
- App: `catalog-infraweaver-console-manifests`
- Auto-sync + selfHeal enabled
- Uses ServerSideApply=true
- Trigger sync: `kubectl patch application catalog-infraweaver-console-manifests -n argocd --type merge -p '{"operation":{"sync":{"revision":"HEAD"}}}'`
