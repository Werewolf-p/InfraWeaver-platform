---
title: NetBird setup-key rotation attempt
description: Record of attempted rotation, failures, and manual remediation steps
---

# NetBird setup-key rotation (2026-04-27)

## Summary
- A new reusable setup key was created and stored in the local runtime status file: /home/runner/.netbird_status.json
- Old key was not revoked to avoid service interruption.
- A revocation_scheduled flag and timestamp were written to /home/runner/.netbird_status.json; a backup was created at /home/runner/.netbird_status.json.bak

## Actions performed
1. Created new setup key: stored as `setup_key` in /home/runner/.netbird_status.json
2. Backed up status file: /home/runner/.netbird_status.json.bak
3. Marked revocation scheduled in status file (revocation_scheduled=true)
4. Ran platform/.github/scripts/sync_netbird_status.py to update platform/.github/memories/netbird-external-vm-setup.md (sanitized)
5. Attempted to update Kubernetes secret netbird/netbird-secrets and restart DaemonSet; failed due to kubeconfig/auth TLS errors. No cluster changes made.

## Observed failure
- Kubectl operations failed: server asked for credentials / TLS verification errors. See command output in session logs. Therefore secret was not updated and DaemonSet not rolled.

## Manual remediation steps (safe)
1. Provide a working kubeconfig with rights to update the netbird namespace, or run the following where kubectl is authenticated:

```bash
export NEW_KEY="$(jq -r .setup_key /home/runner/.netbird_status.json)"
# rotate secret
kubectl -n netbird create secret generic netbird-secrets --from-literal=SETUP_KEY="$NEW_KEY" --dry-run=client -o yaml | kubectl -n netbird apply -f -
# restart clients
kubectl -n netbird rollout restart daemonset/netbird-client
kubectl -n netbird rollout status daemonset/netbird-client --timeout=120s
```

2. After verifying Windows client has registered with the new key and nodes are stable, revoke the old key via the management API (use API PAT from /home/runner/.netbird_status.json):

```bash
API_PAT=$(jq -r .api_pat /home/runner/.netbird_status.json)
BASE=$(jq -r .management_url /home/runner/.netbird_status.json)
OLD_ID=<old-key-id>
curl -X POST -H "Authorization: Token $API_PAT" "$BASE/api/setup-keys/$OLD_ID/revoke"
# fallback: DELETE or PATCH {revoked:true}
```

## Files & backups
- /home/runner/.netbird_status.json (authoritative runtime file)
- /home/runner/.netbird_status.json.bak (backup)
- platform/.github/memories/netbird-external-vm-setup.md (sanitized memory updated)

## Risk
- If old key is revoked before cluster secret is updated, currently-running DaemonSet clients using the old key may fail to re-register.

## Recommended next step
- Provide kubeconfig path or confirm immediate revoke. If user not available, I will wait (current state is safe).

## Related
- platform/.github/scripts/sync_netbird_status.py
- platform/kubernetes/platform/netbird/manifests/client-daemonset.yaml

