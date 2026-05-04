---
title: NetBird Bootstrap Dynamic Account IDs
description: Management auto-creates account with random ID on first start; bootstrap.py must detect and use it
---

# NetBird Bootstrap Dynamic Account IDs

## Memory

- **File paths:** `kubernetes/platform/netbird/manifests/bootstrap-job.yaml`

## Root Cause

NetBird management auto-creates an account with a random ID (e.g., `d7rqo4r7tuas738f0k40`)
when it first starts — BEFORE the bootstrap job runs. The original bootstrap.py used static
hardcoded IDs (`acc00000-...`, `grp00000-...`). When the bootstrap ran and saw `existing_accounts > 0`,
it skipped the `else:` branch but the unconditional section still used `ACC = "acc00000-..."` for
routes and PAT, creating records with the wrong account_id → API returned empty `[]`.

## Fix Applied (commit f112894)

In `bootstrap.py`:
```python
# Detect existing account (management may auto-create with random ID)
existing_acc_row = c.execute("SELECT id FROM accounts LIMIT 1").fetchone()
if existing_acc_row:
    ACC = existing_acc_row[0]
    print(f"Detected existing account: {ACC}")
else:
    print(f"Fresh DB: creating account with static ID: {ACC}")
    # ... insert account
```

Similarly for groups — look up by NAME:
```python
row = c.execute("SELECT id FROM groups WHERE name='All' AND account_id=?", (ACC,)).fetchone()
if row:
    GRP = row[0]
else:
    # Create with static ID fallback
```

## Corrupted resources JSON Bug

In the live system, the routing-peers-vlan3 group had corrupted resources JSON:
```
[{"ID":""d7rqo4r7tuas738f0k60"","Type":"peer"}]  ← WRONG: double-quoted ID
```
This caused the groups API to return HTTP 500 "failed to get account groups from the store".

**Fix:** Update the resources column to valid JSON:
```python
correct_resources = json.dumps([{"ID": peer_id, "Type": "peer"} for peer_id in all_peer_ids])
c.execute("UPDATE groups SET resources=? WHERE id=?", (correct_resources, REAL_GRP_ROUTING))
```

Note: The `resources` column is for NetBird "network resources" (not peer group membership).
Peer membership comes from the `group_peers` table (populated automatically via setup key auto_groups).

## Dynamic ID Export to Shell

Python writes resolved IDs to `/tmp/nb-ids.env`:
```python
with open("/tmp/nb-ids.env", "w") as f:
    f.write(f"GRP={GRP}\n")
    f.write(f"GRP_ROUTING={GRP_ROUTING}\n")
    f.write(f"ACC={ACC}\n")
```

Shell script sources it:
```sh
if [ -f /tmp/nb-ids.env ]; then
    . /tmp/nb-ids.env
else
    # fallback: query API for group IDs
fi
```

## Setup Key Location

`setup_keys` table is inside the `if existing == 0` block in the original code — was NEVER
inserted when management had already auto-created the account. Fixed by moving setup key
insert/update to always run (checks for existing key first).

## YAML Column-0 Gotcha (critical)

Python multiline strings inside shell `$(python3 -c "...")` at column 0 in YAML block scalars
will terminate the YAML block scalar prematurely → `yaml.scanner.ScannerError`.
**Solution:** Use single-line Python always: `python3 -c "import sys,json; ..."`.

## Current Cluster State (after live fix, pre-redeploy)

- Account: `d7rqo4r7tuas738f0k40` (management auto-created, now used by all records)
- All group: `d7rqo4r7tuas738f0k50` (management auto-created)
- routing-peers-vlan3 group: `grp00000-0000-4000-a000-000000000002` (our static ID, fixed)
- Routes: homelab-net (10.25.0.0/24) + vlan3-net (10.10.0.0/24) — both working
- Peers: RemonPC + netbird-router-vlan3
- Setup key: 388f43a5-eb90-4ba0-a7cb-a892408886df (added in live fix)
- PAT: pat00000-0000-4000-a000-000000000001 for user "remon"
- DNS nameservers: prod-local, rlservers-com, int-rlservers-com (created via API)

## Validation

After bootstrap runs on next redeploy:
```bash
kubectl port-forward svc/netbird-management -n netbird 33073:80
PAT=$(kubectl get secret netbird-secrets -n netbird -o jsonpath='{.data.netbird-pat-token}' | base64 -d)
curl -sf http://localhost:33073/api/routes -H "Authorization: Token $PAT" | python3 -m json.tool
curl -sf http://localhost:33073/api/groups -H "Authorization: Token $PAT" | python3 -m json.tool
# Should show routes and groups without 500 error
```
