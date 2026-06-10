## API conventions

Most API routes return JSON and start by validating the NextAuth session. RBAC is enforced either directly in the route or via shared helpers such as `getSessionRBACContext()` and `getGameHubAccessContext()`.

## Game Hub API

### GET `/api/game-hub/servers`

Returns the list of game servers the caller can access.

**Auth:** Required  
**RBAC:** `game-hub:read` or an equivalent platform role

**Response:**

```json
{
  "servers": [
    {
      "name": "minecraft-server",
      "status": "Running",
      "ready": true,
      "image": "itzg/minecraft-server:latest",
      "gameType": "minecraft-java",
      "players": 3,
      "maxPlayers": 20,
      "cpu": "245m",
      "memory": "1.2Gi",
      "uptime": "2d 14h"
    }
  ]
}
```

### POST `/api/game-hub/servers`

Creates a new game server deployment, PVC, Service, and ConfigMap.

**Auth:** Required  
**RBAC:** `game-hub:write` / `game-hub:admin` or equivalent elevated platform role

**Request body:**

```json
{
  "name": "my-server",
  "egg": "minecraft-java",
  "image": "itzg/minecraft-server:latest",
  "memory": "2Gi",
  "cpu": "1",
  "storage": "10Gi",
  "env": {
    "EULA": "TRUE",
    "TYPE": "PAPER"
  }
}
```

**Response:**

```json
{
  "name": "my-server",
  "game": "minecraft-java",
  "status": "creating"
}
```

### GET `/api/game-hub/eggs`

Returns built-in eggs defined in `src/lib/game-eggs.ts`.

**Auth:** Required  
**RBAC:** authenticated session

### GET `/api/game-hub/eggs/catalog`

Returns the cached Pelican egg catalog grouped by category.

**Auth:** Required  
**RBAC:** authenticated session

### GET `/api/game-hub/eggs/catalog/[...path]`

Resolves a single Pelican egg path into a normalized `GameEgg` document.

**Auth:** Required  
**RBAC:** authenticated session

### GET `/api/game-hub/capacity`

Returns node pressure and projected safety checks for a proposed memory and CPU request.

**Auth:** Required  
**RBAC:** Game Hub access

### GET `/api/game-hub/setup`

Returns bootstrap readiness information such as available storage classes.

**Auth:** Required  
**RBAC:** Game Hub access

## DNS API

### GET `/api/dns`

Lists managed Cloudflare-backed DNS records.

**Auth:** Required  
**RBAC:** currently session-authenticated; intended for platform operators and viewers

**Response:**

```json
{
  "records": [
    {
      "id": "abc123",
      "name": "minecraft.games.int.example.com",
      "shortName": "minecraft.games",
      "type": "A",
      "value": "10.10.0.90",
      "ttl": 120,
      "internal": true
    }
  ]
}
```

### POST `/api/dns`

Creates a managed DNS record.

**Auth:** Required  
**RBAC:** currently session-authenticated; intended for platform operators and above

**Request body:**

```json
{
  "name": "minecraft.games",
  "value": "10.10.0.90",
  "type": "A",
  "internal": true,
  "ttl": 120
}
```

### PATCH `/api/dns/[id]`

Updates the value or TTL of an existing DNS record.

**Auth:** Required  
**RBAC:** currently session-authenticated

### DELETE `/api/dns/[id]`

Deletes a managed DNS record.

**Auth:** Required  
**RBAC:** currently session-authenticated

## Metrics API

### GET `/api/metrics/history/[namespace]/[pod]`

Queries Prometheus for one hour of CPU and memory history for a pod.

**Auth:** Required  
**RBAC:** access to the target workload, including scoped Game Hub access where applicable

**Response:**

```json
[
  {
    "cpu": 0.22,
    "cpuLimit": 1,
    "memory": 531628032,
    "memoryLimit": 2147483648,
    "cpuRaw": 220,
    "memoryRaw": 531628032,
    "timestamp": "2026-05-13T12:00:00.000Z"
  }
]
```

### GET `/api/game-hub/servers/[name]/stats`

Parses recent logs to produce player activity statistics for a server.

**Auth:** Required  
**RBAC:** `game-hub:read` for the target server

## Cluster API

### GET `/api/cluster/nodes`

Returns node inventory, ready state, roles, version, and capacity.

**Auth:** Required  
**RBAC:** `infra:read` or `config:read`

### GET `/api/cluster/metrics`

Returns CPU and memory percentages for each node.

**Auth:** Required  
**RBAC:** `config:read`

### GET `/api/cluster/quota`

Returns namespace quota and usage information.

**Auth:** Required  
**RBAC:** infrastructure read access

## Users API

### GET `/api/users-config`

Loads `users.yaml` from GitHub and returns normalized user records.

**Auth:** Required  
**RBAC:** `users:read`

### POST `/api/users-config`

Writes a new `users.yaml` payload back to GitHub.

**Auth:** Required  
**RBAC:** `users:write`

### POST `/api/users/invite`

Starts the user invite workflow.

**Auth:** Required  
**RBAC:** `users:invite`

### POST `/api/users/reset-password`

Triggers the recovery or password reset flow for a user.

**Auth:** Required  
**RBAC:** user administration privileges

## Community Apps API

### GET `/api/community-apps`

Returns paginated AppFeed search results with optional filters for search, category, and tier.

**Auth:** Required  
**RBAC:** `apps:read`

### GET `/api/community-apps/installed`

Returns the installed community apps discovered from git-managed bootstrap files.

**Auth:** Required  
**RBAC:** `apps:read`

### POST `/api/community-apps/deploy`

Converts a selected AppFeed entry and commits generated manifests into the repo.

**Auth:** Required  
**RBAC:** `catalog:write`

## Logs API

### GET `/api/logs/stream`

Streams pod logs as Server-Sent Events.

**Auth:** Required  
**RBAC:** workload-specific access; Game Hub uses scoped access checks before a stream is opened

**Query parameters:** `namespace`, `pod`, `container`

**Response:** `text/event-stream`

## Error model

Most routes use a simple error envelope:

```json
{
  "error": "Forbidden"
}
```

Common status codes:

- `400` invalid request body or parameters
- `401` unauthenticated session
- `403` authenticated but not authorized
- `404` target resource not found
- `429` rate limit exceeded
- `500` unexpected server error
