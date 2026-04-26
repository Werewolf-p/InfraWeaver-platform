---
title: NetBird v0.69.0 SQLite DB Bootstrap Procedure
description: How to bootstrap the NetBird management store.db from scratch on Kubernetes with local-path PVC
---

# NetBird v0.69.0 SQLite DB Bootstrap

## Memory

- **File paths:** `platform/kubernetes/apps/netbird/manifests/management.yaml`, `store.db` on PVC `netbird-management-data` (local-path, bound to `talos-prod-cp2`)
- **Decision:** Bootstrap via direct SQLite manipulation while management is scaled to 0, using a pod that mounts the PVC
- **Why it matters:** Management crashes with `invalid IP address: ZEAAAA==` if network_net uses base64 for the IP field; it crashes with JSON unmarshal errors if policy JSON types are wrong

## Critical DB Field Formats for v0.69.0

### `accounts.network_net`
```json
{"IP":"100.64.0.0","Mask":"//8AAA=="}
```
- `IP` = **dotted-decimal string** (NOT base64 bytes). `net.IP` implements `TextUnmarshaler` → `net.ParseIP()` requires dotted decimal
- `Mask` = **base64 bytes**. `net.IPMask` does NOT implement `TextMarshaler` → JSON uses default `[]byte` → base64
- `/16` mask `[255,255,0,0]` → `//8AAA==`
- `/10` mask `[255,192,0,0]` → `/8AAAA==`

### `setup_keys` (v0.69.0 hashed format)
- `key` column = `base64(sha256(UPPERCASE_UUID_WITH_DASHES))` — lookup key
- `key_secret` column = first 5 chars of UUID + `"****"` — display only
- Management does: `upperKey = strings.ToUpper(inputKey)` → `sha256(upperKey)` → base64 → `WHERE key = ?`
- Migration `MigrateSetupKeyToHashedSetupKey` runs only if `key_secret IS NULL OR ''` AND `SUBSTR(key, 9, 1) = '-'` (plain UUID format in old `key` column)

### `policies.source_posture_checks`
```json
[]
```
- Go type is `[]string` — must store **empty JSON array `[]`**, NOT `{}`
- Storing `{}` causes: `json: cannot unmarshal object into Go value of type []string`

### `policy_rules.authorized_groups`
```json
{}
```
- Go type is `map[string][]string` — store as **`{}` (empty JSON object)** or SQL `NULL`
- Storing `[]` causes: `json: cannot unmarshal array into Go value of type map[string][]string`
- **`{}` is verified working**; `NULL` also works but management may rewrite as `null`

### `policy_rules.destination_resource` / `policy_rules.source_resource`
- Go type is `Resource` struct — store as **SQL `NULL`** NOT `''` (empty string)
- Storing `''` causes GORM JSON deserializer to fail with `unexpected end of JSON input`
- That silent GORM error corrupts the policy save-back, causing `authorized_groups` to revert to `[]`
- **Always use `NULL` for empty GORM JSON-serialized struct fields, never empty string `''`**

### `policy_rules.sources` / `policy_rules.destinations`
```json
["group-id-here"]
```
- Go type is `[]string` — JSON array of group IDs

### `policy_rules.ports` / `policy_rules.port_ranges`
```json
[]
```
- Empty JSON array

## Full Bootstrap SQL (minimal working state)

```sql
-- 1. accounts: fix network_net (IP must be dotted-decimal)
-- Only needed if it was stored as base64 (migration bug in very old bootstrap)
-- Check: SELECT network_net FROM accounts; -- should be {"IP":"100.64.0.0","Mask":"//8AAA=="}

-- 2. setup_keys: insert hashed key for A1B2C3D4-E5F6-7890-ABCD-EF1234567890
-- base64(sha256("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")) = mewqgKYulb4neyT85tvUyw1QzCAhxDjA9+5h7WeAysw=
INSERT OR IGNORE INTO setup_keys (id, account_id, key, key_secret, name, type, used_times, last_used, expiry_time, auto_groups, revoked, ephemeral, updated_at, created_at, usage_limit)
VALUES (
  '388f43a5-eb90-4ba0-a7cb-a892408886df',
  (SELECT id FROM accounts LIMIT 1),
  'mewqgKYulb4neyT85tvUyw1QzCAhxDjA9+5h7WeAysw=',
  'A1B2C****',
  'Default Key',
  'reusable',
  0,
  '0001-01-01 00:00:00',
  '0001-01-01 00:00:00',
  '[]',
  0,
  0,
  datetime('now'),
  datetime('now'),
  0
);

-- 3. groups: insert All group
INSERT OR IGNORE INTO groups (id, account_id, name, issued, resources, integration_ref_id, integration_ref_integration_type)
VALUES (
  '18d223c6-9999-4444-bbbb-000000000001',
  (SELECT id FROM accounts LIMIT 1),
  'All',
  'api',
  '[]',
  0,
  ''
);

-- 4. policies: default allow-all
INSERT OR IGNORE INTO policies (id, account_id, name, description, enabled, source_posture_checks)
VALUES (
  'def00001-0000-4000-a000-000000000001',
  (SELECT id FROM accounts LIMIT 1),
  'Default',
  'Allow all cluster peers',
  1,
  '[]'   -- NOTE: []string type, NOT map
);

-- 5. policy_rules: allow all peers in All group
-- CRITICAL: use NULL (not '') for destination_resource and source_resource
-- Using '' causes GORM JSON unmarshal error → corrupts authorized_groups on save-back
INSERT OR IGNORE INTO policy_rules (id, policy_id, name, description, enabled, action, destinations, destination_resource, sources, source_resource, bidirectional, protocol, ports, port_ranges, authorized_groups, authorized_user)
VALUES (
  'def00001-0000-4000-a000-000000000002',
  'def00001-0000-4000-a000-000000000001',
  'Default',
  'Allow all in All group',
  1,
  'accept',
  '["18d223c6-9999-4444-bbbb-000000000001"]',
  NULL,   -- NOT '' — empty string breaks GORM JSON serializer
  '["18d223c6-9999-4444-bbbb-000000000001"]',
  NULL,   -- NOT '' — empty string breaks GORM JSON serializer
  1,
  'all',
  '[]',
  '[]',
  NULL,   -- map[string][]string: NULL (or '{}') is correct, never '[]'
  ''
);
```

## How to Run Bootstrap Pod Safely

1. Scale management to 0: `kubectl scale deployment netbird-management -n netbird --replicas=0`
2. Create ConfigMap with SQL: `kubectl create configmap netbird-sql-fix -n netbird --from-literal=q.sql="$SQL"`
3. Run one-shot pod mounting PVC + ConfigMap:
```bash
kubectl run netbird-fix --restart=Never -n netbird --image=alpine \
  --overrides='{
    "spec": {
      "containers": [{"name":"c","image":"alpine",
        "command":["sh","-c","apk add sqlite -q 2>/dev/null; sqlite3 /data/store.db < /cfg/q.sql; echo done"],
        "volumeMounts":[{"name":"data","mountPath":"/data"},{"name":"cfg","mountPath":"/cfg"}]}],
      "volumes": [
        {"name":"data","persistentVolumeClaim":{"claimName":"netbird-management-data"}},
        {"name":"cfg","configMap":{"name":"netbird-sql-fix"}}
      ],
      "restartPolicy":"Never"
    }
  }'
```
4. Check logs, then clean up: `kubectl delete pod netbird-fix; kubectl delete cm netbird-sql-fix -n netbird`
5. Scale management back to 1

## Lesson Learned

- **JSON type errors are asymmetric**: `cannot unmarshal array into map[string][]string` = field has `[]` but needs `{}` or `NULL`. `cannot unmarshal object into []string` = field has `{}` but needs `[]`. Fix one error → reveals the next.
- **GORM JSON serialized struct fields**: ALWAYS use SQL `NULL` for empty structs, NEVER empty string `''`. Empty string `''` causes `unexpected end of JSON input` → silently corrupts account save-back → causes other fields (like `authorized_groups`) to revert to wrong values on next save
- **`authorized_groups` reversion root cause**: It was caused by `destination_resource = ''` / `source_resource = ''` GORM errors during policy deserialization. When GORM fails to load the rule, it saves back a partially-constructed rule with nil/zero fields. Using `NULL` for all JSON-serialized struct fields eliminates this issue.
- **policy error location**: `sql_store.go:3703` = `getPoliciesFromStore` — policies table scan failure blocks ALL peer sync
- **source_posture_checks** = `[]` (empty array, Go type `[]string`)
- **authorized_groups** = `NULL` or `{}` (Go type `map[string][]string`; `NULL` is safest)
- **destination_resource / source_resource** = `NULL` (Go type `Resource` struct; `NULL` → zero value, no error)
- Always scale management to 0 before editing SQLite DB — even with WAL mode, concurrent writes from management + bootstrap pod cause data corruption risk

## Related

- `platform/kubernetes/apps/netbird/manifests/management.yaml`
- `platform/kubernetes/apps/netbird/manifests/client-daemonset.yaml`
- Secret `netbird-secrets` in namespace `netbird` (key: `SETUP_KEY`) = `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
- PVC `netbird-management-data` → local-path on `talos-prod-cp2` — see `local-path-pvc-node-affinity.md`

## MetalLB IP Assignments (netbird namespace)
- `10.25.0.202` — netbird-relay-lb (ports 33080 relay, 3478 TURN)
- `10.25.0.203` — netbird-management-lb (ports 80, 33073)
- `10.25.0.204` — netbird-signal-lb (port 10000)

## Traefik ExternalTrafficPolicy (CRITICAL)

Traefik service MUST have `externalTrafficPolicy: Local` for the `netbird-only` IPAllowList middleware to work correctly. With the default `Cluster` policy, kube-proxy SNAT's traffic and Traefik sees the pod CIDR IPs instead of real client IPs → all requests get 403.

```bash
kubectl patch svc traefik -n traefik -p '{"spec":{"externalTrafficPolicy":"Local"}}'
```

Also set in `platform/kubernetes/core/traefik/values.yaml`:
```yaml
service:
  spec:
    externalTrafficPolicy: Local
```

## NetBird-only Access (ArgoCD + Grafana)

The `netbird-only` Middleware in `traefik` namespace allows:
- `100.64.0.0/10` — NetBird CGNAT VPN IPs
- `10.25.0.0/24` — Local LAN (homelab management)
- `127.0.0.1/32` — Localhost

Apply to sensitive services via ingress annotation:
```
traefik.ingress.kubernetes.io/router.middlewares: traefik-netbird-only@kubernetescrd
```

Applied to: ArgoCD (`argocd/argocd-server`), Grafana (`monitoring/kube-prometheus-stack-grafana`)
Public test website does NOT have this middleware (intentionally public).
