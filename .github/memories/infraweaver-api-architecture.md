---
title: InfraWeaver API — Hub Architecture & Trust Model
description: Multi-cluster middleware API with hub-and-spoke agent model, mode system, and bidirectional HMAC security
---

# InfraWeaver API Architecture

## Memory

### File Paths
- `apps/infraweaver-api/` — Hub API (Hono/Node.js, port 3001)
- `apps/infraweaver-node/` — Per-cluster Node Agent (WebSocket client, outbound only)
- `kubernetes/catalog/infraweaver-api/manifests/` — Hub API k8s manifests
- `kubernetes/catalog/infraweaver-node/manifests/` — Node Agent k8s manifests (deploy to each remote cluster)

### Architecture Overview

```
Browser (Console UI)  [infraweaver.int.rlservers.com]
        ↓  NextAuth/Authentik SSO (unchanged)
Next.js Console Server
        ↓  X-Console-Sig HMAC + X-User-Id + X-User-Roles + X-Cluster-Id
InfraWeaver Hub API  [api.int.rlservers.com, port 3001]
        ↑  WebSocket connections (outbound FROM each cluster)
  homelab-prod Node Agent | homelab-staging Node Agent | future clusters...
  (in-cluster pod, uses own SA, connects outbound only)
```

### Trust Model: Console → Hub API

**Request signing (Console → Hub):**
```
X-Console-Sig: HMAC-SHA256(ts:userId:rolesCsv, CONSOLE_API_SECRET)
X-Console-Ts:  unix timestamp (ms)
X-User-Id:     user identifier
X-User-Roles:  comma-separated role IDs
X-Cluster-Id:  target cluster ID (default: "local")
X-Request-Id:  UUID per request
```

**Response signing (Hub → Console):** ← BIDIRECTIONAL (anti-tamper)
```
X-Api-Sig: HMAC-SHA256(statusCode:requestId:ts, CONSOLE_API_SECRET)
X-Request-Id: echoed from request
```

**Why bidirectional matters:** If a hacker changes DNS to point to a fake API, the fake server cannot sign responses correctly (doesn't have CONSOLE_API_SECRET). The console rejects unsigned/incorrectly-signed responses → data breach prevented.

**Additional protections:**
- `|Date.now() - X-Console-Ts| > 30000ms` → 401 (replay protection)
- `ALLOWED_CONSOLE_ORIGINS` env var — whitelist of valid console origins
- `CONSOLE_API_TLS_FINGERPRINT` optional — console pins Hub's TLS cert fingerprint

### Trust Model: Hub ↔ Node Agent (ECDSA P-256)

**Registration (one-time):**
1. Hub generates one-time JWT token with `clusterId` claim (15min TTL)
2. Admin applies generated manifest to target cluster (with token as env var)
3. Agent generates ECDSA P-256 keypair
4. Agent → Hub: `{ type: "register", token, publicKey, clusterCaFingerprint }`
5. Hub validates JWT, stores agent's public key
6. Hub → Agent: `{ type: "registered", hubPublicKey, clusterId }` (Hub signs this with its private key)
7. Agent saves state to k8s Secret `infraweaver-node-state`

**Normal operation:**
- Agent maintains persistent WebSocket to `wss://api.int.rlservers.com/v1/ws/cluster/{clusterId}`
- Every 30s heartbeat: agent signs and sends `{ type: "heartbeat", ts, status }`
- Command frames (Hub → Agent): signed with Hub's private key
- Response frames (Agent → Hub): signed with agent's private key
- Both sides verify ECDSA signatures — unsigned frames are silently dropped

**Anti-tamper:** If Hub URL is changed to attacker's server:
- Attacker doesn't have Hub's ECDSA private key
- Agent rejects incorrectly signed command frames
- No commands execute on the cluster

### Mode System

```
LIVE mode (default):     Full read + write. All routes open.
DEPLOYMENT mode:         Read-only. POST/PUT/DELETE → 503 + Retry-After header.
```

- Stored in ConfigMap `infraweaver-api-mode` (namespace: `infraweaver-console`, key: `mode`)
- Cached in-memory for 5 seconds (reduces k8s API calls)
- `PUT /v1/mode { mode: "deployment" | "live" }` — requires `cluster:admin` permission
- CI pipeline sets DEPLOYMENT mode before rolling deploy, LIVE mode after
- Console shows banner when in DEPLOYMENT mode (SSE event: `mode-change`)

**Why store in ConfigMap (not env var):** Survives pod restarts; can be changed at runtime without redeployment.

### Cluster Registry

Two k8s resources per cluster in `infraweaver-system` namespace:
1. ConfigMap `infraweaver-cluster-registry` — array of ClusterMeta (no credentials)
   - `{ id, name, description, endpoint, tags, status, lastSeen, isLocal }`
2. Secret `infraweaver-cluster-creds-{id}` — kubeconfig (for kubeconfig-based registration) OR `agentPublicKey` (for agent-based registration)

Local cluster auto-registers on startup with `id: "local"`, `isLocal: true`.

### Node Agent vs Direct kubeconfig

| Feature | Agent model (infraweaver-node) | Direct kubeconfig |
|---|---|---|
| Remote cluster needs open port? | No (outbound only) | Yes (k8s API must be reachable) |
| Credential management | ECDSA keypair (no rotation needed) | kubeconfig (must rotate) |
| Security | Mutual ECDSA auth, no stored cluster creds | Cluster admin kubeconfig in Hub Secret |
| Adding new cluster | Apply 1 manifest | Paste kubeconfig |
| Hub can be replaced | Yes (re-register with new Hub) | No (must update kubeconfig in Hub) |

### RBAC Enforcement

Hub enforces permissions server-side regardless of what the frontend sends:
```typescript
// Every mutating route does this:
if (!hasPermission(user, 'apps:sync')) return c.json({ error: 'Forbidden' }, 403)
```

Role permissions map mirrors the console's `lib/permissions.ts` exactly.
Frontend RBAC is UX only (grey out buttons). API is the security layer.

### Decision: Why Hono (not Express/Fastify)

- Hono is 5-10x faster than Express for Kubernetes-internal traffic
- First-class TypeScript with Hono middleware typing
- Edge-compatible (future-proofs for CloudFlare Workers if needed)
- `hono/middleware` includes CORS, logger, rate-limiter out of the box

### Lesson Learned

- ArgoCD notifications controller does NOT support `extraRules` in Helm values in argo-cd-9.5.12
  → Must create separate Role + RoleBinding manifest in `kubernetes/core/argocd/manifests/`
- `notifications.extraRules` field exists in newer chart versions but not 9.5.12

### Related

- `apps/infraweaver-console/src/lib/kube-client.ts` — will be replaced by API client during Phase 3
- `apps/infraweaver-console/src/lib/infraweaver-api-client.ts` — NEW: console→API HMAC client
- `kubernetes/catalog/infraweaver-console/manifests/rbac.yaml` — will be narrowed in Phase 3
- `.github/memories/security-assessment-2026-05.md` — security findings that motivated this API layer

---

## Zero-Config Extensions (2026-05-15)

### Agent Discovery Mode (tokenless onboarding)

The minimal agent manifest only needs ONE env var:
```yaml
env:
  - name: HUB_URL
    value: "wss://api.int.rlservers.com"
  # No REGISTRATION_TOKEN needed!
```

Flow:
1. Agent starts without state and without `REGISTRATION_TOKEN`
2. Enters **discovery mode**: connects to `wss://HUB_URL/v1/ws/discover`
3. Sends `hello` frame: `{ type, agentId, clusterName, publicKey, clusterCaFingerprint }`
4. Hub stores in `_pendingDiscovery` map, sends `{ type: "ack", status: "pending_approval" }`
5. WS stays open — agent waits (up to 5 min)
6. Console shows notification badge: "🔔 homelab-dev wants to connect (3 nodes) [Approve] [Deny]"
7. Admin approves + assigns cluster ID/name → Hub sends `{ type: "approved", clusterId, hubPublicKey }`
8. Agent saves state to k8s Secret, switches to normal operation

vs. token flow (still supported):
- `REGISTRATION_TOKEN` set → uses old token registration path (instant, no admin action needed)
- No token → discovery mode (admin approval required)

Hub API endpoints added:
- `GET /v1/agents/pending` — list discovery requests
- `POST /v1/agents/pending/:agentId/approve` — approve + assign cluster ID
- `POST /v1/agents/pending/:agentId/reject` — reject

### Hub Auto-Bootstrap (zero-config same-cluster install)

If `CONSOLE_API_SECRET` is not set as env var:
1. Hub tries to read from k8s Secret `infraweaver-api-console-secret` key `CONSOLE_API_SECRET`
2. If Secret exists → use it
3. If Secret doesn't exist → generate `randomBytes(32).toString('hex')`, create Secret
4. Sets `process.env.CONSOLE_API_SECRET` for all subsequent requests

The console reads the same Secret via ExternalSecret / direct mount → same key, zero manual config.
Works perfectly for same-cluster installs (Hub + Console in same namespace).

**File:** `apps/infraweaver-api/src/lib/bootstrap.ts`

### Security properties preserved:
- Discovery mode: agent generates fresh ECDSA keypair per discovery session
- Hub verifies approved agent's public key before sending commands
- Bootstrap secret: generated with `crypto.randomBytes(32)` (256 bits entropy)
- Both token and discovery modes end up with the same ECDSA mutual-auth state
