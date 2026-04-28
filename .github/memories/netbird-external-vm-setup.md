---
title: NetBird External VM Setup (10.25.0.100)
description: Self-hosted NetBird management server running on dedicated VM, with K8s nodes as peers
---

# NetBird External VM Architecture

## Overview
NetBird management moved from in-cluster Kubernetes to a dedicated VM at **10.25.0.100**.
K8s nodes connect to this external management via the `netbird-client` DaemonSet.
Traefik at 10.25.0.5 exposes `netbird.rlservers.com` → 10.25.0.100.

## VM Details
- **Host**: Proxmox `pve1` (10.25.0.3), VM ID varies
- **IP**: `10.25.0.100`
- **OS**: Ubuntu 24.04 cloud-init
- **User**: `ubuntu`
- **Stack**: Docker Compose at `/opt/netbird/docker-compose.yml`
- **Management URL**: `https://netbird.rlservers.com`
- **Zitadel (identity)**: `https://netbird.rlservers.com/zitadel`

## Critical Secrets — NEVER LOSE
- **DataStoreEncryptionKey**: <REDACTED — stored on VM `/opt/netbird/management.json`>
  - Stored in `/opt/netbird/management.json`
- **Setup Key (reusable)**: <REDACTED — stored as K8s secret `netbird/netbird-secrets` key `SETUP_KEY`>
  - Used by K8s DaemonSet to register nodes as peers
- **Relay secret**: <REDACTED — stored on VM `/opt/netbird/relay.env` as `NB_AUTH_SECRET`>
  - Stored in `/opt/netbird/relay.env` as `NB_AUTH_SECRET`
- **Admin Zitadel PAT**: <REDACTED — managed in Zitadel; do not store in repo>
- **NetBird Management API PAT**: <REDACTED — stored in local runtime file `/home/runner/.netbird_status.json`>
  - PAT hash in DB: <REDACTED>
  - Use with: `Authorization: Token <REDACTED>`

## DB Identifiers
- **Account ID**: `ff70dcdf-66bc-476e-9095-6c1b00ff63ce`
- **All group ID**: `b49ad520-7b58-4f40-b4fe-8a972deab7eb`
- **Admin user ID**: `321996cb-3822-448c-a7d4-de8633b769cd`

## NetBird Management DB
- **On VM**: `/var/lib/docker/volumes/netbird_netbird_management/_data/store.db`
- **Access**: `ssh ubuntu@10.25.0.100` then `docker cp netbird-management-1:/var/lib/netbird/store.db /tmp/store.db`

## PAT Token Format (CRITICAL for creating new tokens)
```
Full token = "nbp_" + 30 random base62 chars + 6-char base62-encoded CRC32(those 30 chars) = 40 chars total
Hash stored in DB = base64(SHA256(full_40_char_token))  [standard base64 with padding]
```
See `netbird-v0.69.0-db-bootstrap.md` for full DB schema notes.

## K8s DaemonSet Configuration
File: `platform/kubernetes/apps/netbird/manifests/client-daemonset.yaml`
```yaml
env:
  - name: NB_MANAGEMENT_URL
    value: "https://netbird.rlservers.com"
  - name: NB_SETUP_KEY
    valueFrom:
      secretKeyRef:
        name: netbird-secrets
        key: SETUP_KEY
hostAliases:
  - ip: "10.25.0.5"       # Traefik routes netbird.rlservers.com → 10.25.0.100
    hostnames: ["netbird.rlservers.com"]
```

## Peer Churn Warning
K8s DaemonSet pods create a **new peer** every time they restart (new pod name).
After restarts, routes may point to stale peer IDs.
Fix: Use NetBird API to update routes to the new connected peer ID:
```bash
# Find current connected peer for cp1
curl -s -H "Authorization: Token $NB_TOKEN" \
  https://netbird.rlservers.com/api/peers | python3 -c "
import json,sys
for p in json.load(sys.stdin):
    print(p['id'], p['name'], p.get('connected'), p.get('ip'))
"
# Then update the route
curl -X PUT -H "Authorization: Token $NB_TOKEN" \
  -H "Content-Type: application/json" \
  https://netbird.rlservers.com/api/routes/<ROUTE_ID> \
  -d '{"peer": "<NEW_PEER_ID>", "network": "10.25.0.0/24", ...}'
```

## Routes (advertised to all NetBird peers)
Created via API with `masquerade: true`:
- `10.25.0.0/24` — Homelab LAN (via talos-prod-cp1)
- `10.96.0.0/12` — K8s service CIDR incl. CoreDNS 10.96.0.10 (via talos-prod-cp1)

## DNS (NetBird nameserver → CoreDNS)
- NetBird pushes DNS: `prod.local` → `10.96.0.10:53` (K8s CoreDNS)
- CoreDNS hosts for `prod.local`: all → `10.25.0.200` (MetalLB LB)
  - `grafana.prod.local`, `argocd.prod.local`, `longhorn.prod.local`, `test.prod.local`, `netbird.prod.local`

## NetBird Policy: All-to-All
```sql
-- policy: allow All group ↔ All group, all protocols, bidirectional
-- See netbird-v0.69.0-db-bootstrap.md for exact SQL schema
```
Created directly in SQLite; allows K8s nodes + github-runner + any new peer to communicate.

## Admin User Credentials
- **Email**: `remonhulst@gmail.com`
- **Password**: stored in Zitadel, set during VM bootstrap
- **Login**: https://netbird.rlservers.com/zitadel or NetBird dashboard UI

## API Examples
```bash
NB_TOKEN="<REDACTED - set from /home/runner/.netbird_status.json or environment>"
NB_URL="https://netbird.rlservers.com"

# List peers
curl -s -H "Authorization: Token $NB_TOKEN" $NB_URL/api/peers | python3 -m json.tool

# List routes
curl -s -H "Authorization: Token $NB_TOKEN" $NB_URL/api/routes | python3 -m json.tool

# List DNS nameservers
curl -s -H "Authorization: Token $NB_TOKEN" $NB_URL/api/dns/nameservers | python3 -m json.tool
```

## Related Files
- `platform/kubernetes/apps/netbird/manifests/client-daemonset.yaml` — K8s DaemonSet
- `platform/kubernetes/core/traefik/middleware-netbird.yaml` — IPAllowList for sensitive services
- `infrastructure/` — Proxmox VM provisioning for 10.25.0.100



## Live status file (sanitized)
- **Management URL:** https://netbird.rlservers.com
- **Routes (sanitized, no secrets):**
  - 10.25.0.0/24 -> peer=d7nn6jrdeh7s7388jdq0 enabled=True
  - 10.96.0.0/12 -> peer=d7nn6jrdeh7s7388jdq0 enabled=True
- **Last verified:** 2026-04-27T16:43:32Z

Note: secrets (API PAT, setup keys, DB encryption keys) are intentionally omitted from this memory.

## Related Files
- `platform/kubernetes/apps/netbird/manifests/client-daemonset.yaml` — K8s DaemonSet
- `platform/kubernetes/core/traefik/middleware-netbird.yaml` — IPAllowList for sensitive services
- `infrastructure/` — Proxmox VM provisioning for 10.25.0.100
