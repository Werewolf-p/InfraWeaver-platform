---
title: etcd raft log corruption from hard reset — recovery procedure
description: When pve-prod1 is hard-killed, CP1's etcd gets raft log corruption (tocommit out of range). Recovery requires removing the corrupted member and wiping the EPHEMERAL partition.
---

# etcd Raft Log Corruption After Hard Reset

## Memory

- **File paths:** CP1: VM 9300, pve-prod1; talosctl binary at `/tmp/talosctl` on prod-worker (or install fresh)
- **Decision:** The only reliable recovery is: remove corrupt member from healthy cluster → wipe EPHEMERAL via `talosctl reset` → wait for rejoin.
- **Why it matters:** Hard resets (OOM kills of pve-prod1, or direct `qm reset`) leave etcd with partial writes. Raft logs can have `tocommit` index ahead of `lastIndex` — the node cannot start until the corrupt data is cleared.

## Symptom Pattern

After pve-prod1 is OOM-killed or hard-reset, CP1 (10.25.0.90) shows:

```
# In talosctl logs or talos machined:
PANIC: tocommit(14381) is out of range [lastIndex(14153)].
Was the raft log corrupted, truncated, or lost?
```

Or the earlier I/O error that precedes corruption:
```
lstat /run/containerd/io.containerd.runtime.v2.task/system/etcd/rootfs: input/output error
```

The K8s API never becomes ready on CP1, but CP2 and CP3 remain healthy (quorum maintained at 2/3).

## Recovery Procedure

### Step 1: Verify CP2/CP3 are healthy

```bash
# From prod-worker or management runner:
talosctl etcd members --talosconfig /tmp/tc.yaml \
  --endpoints 10.25.0.91 --nodes 10.25.0.91 2>&1
```

Look for CP1 member (`dc99799260cdfb8e` or similar) in the list.

### Step 2: Remove CP1's corrupted etcd member

```bash
# Get CP1's member ID from the members list, then:
talosctl etcd remove-member <MEMBER_ID> \
  --talosconfig /tmp/tc.yaml --endpoints 10.25.0.91 --nodes 10.25.0.91
```

### Step 3: Wipe CP1's EPHEMERAL partition

```bash
talosctl reset --system-labels-to-wipe EPHEMERAL --reboot \
  --talosconfig /tmp/tc.yaml \
  --endpoints 10.25.0.90 --nodes 10.25.0.90
```

This takes ~3-4 minutes. After the reboot:
- CP1 starts fresh etcd data
- Talos detects it needs to join an existing cluster
- CP1 appears as learner → gets promoted to voter after sync

### Step 4: Wait for CP1 to rejoin

```bash
# Poll until CP1 is Ready
for i in $(seq 1 20); do
  kubectl --kubeconfig /tmp/kube-cp2.yaml get node talos-prod-cp1 2>/dev/null && break
  echo "Waiting... ($i/20)"
  sleep 15
done
```

## IMPORTANT: talosctl `reset --reboot` After Kexec Issue

After `talosctl reset --system-labels-to-wipe EPHEMERAL --reboot`, the VM may enter "kexec limbo" where:
- Ping works
- ALL TCP ports timeout (50000, 6443, etc.)

**If this happens, hard-restart the VM:**
```bash
ssh root@10.25.0.80 "qm stop 9300 && sleep 5 && qm start 9300"
```

## Kubeconfig for Operations While CP1 is Down

```bash
# Regenerate talosconfig from tfstate
python3 -c "
import json
with open('/home/ubuntu/.tofu/state/platform-productie/terraform.tfstate') as f:
    state = json.load(f)
for res in state['resources']:
    for inst in res['instances']:
        attrs = inst.get('attributes', {})
        if 'talos_config' in attrs:
            open('/tmp/tc.yaml', 'w').write(attrs['talos_config'])
            print('done, size:', len(attrs['talos_config']))
"

# Generate kubeconfig via CP2 (not CP1)
talosctl kubeconfig /tmp/kube-cp2.yaml --force \
  --talosconfig /tmp/tc.yaml --endpoints 10.25.0.91 --nodes 10.25.0.91

# Patch endpoint to use CP2 API server
sed -i 's|10.25.0.90:6443|10.25.0.91:6443|g' /tmp/kube-cp2.yaml
export KUBECONFIG=/tmp/kube-cp2.yaml
```

## Lesson Learned

- This pattern was triggered 3 times in one session by pve-prod1 OOM kills
- `talosctl reset --system-labels-to-wipe EPHEMERAL` is the correct wipe target (not ETCD — no such partition)
- After EPHEMERAL wipe, no manual `talosctl etcd join` is needed — Talos handles rejoining automatically
- Source of quorum safety: CP2 (10.25.0.91) on pve-prod2 and CP3 (10.25.0.92) on pve-prod3 are independent hosts; losing CP1 alone does NOT break quorum
