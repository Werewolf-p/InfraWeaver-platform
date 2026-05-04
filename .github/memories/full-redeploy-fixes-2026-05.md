# Full Redeploy Fixes — May 2026

## Root Causes Found & Fixed

### 1. YAML syntax error in full-redeploy.yml (CRITICAL)
- **Bug**: Python code at column 0 inside `run: |` blocks terminates YAML block scalars
- **Effect**: GitHub reported "Workflow does not have 'workflow_dispatch' trigger" — couldn't trigger at all
- **Fix**: Replace `python3 -c "multiline..."` with one-liners; replace heredocs with `printf` statements
- **Commit**: b3365a7

### 2. Router reconnect step hung indefinitely
- **Bug**: "Reconnect NetBird router VM" ran BEFORE "Apply MetalLB IP Pool", so `netbird up` blocked
  waiting for management URL `10.10.0.202` which wasn't yet active
- **Fix**: Moved router reconnect step to AFTER Apply MetalLB; added `timeout-minutes: 4`;
  run `netbird up &` (background) so it doesn't block SSH session
- **Commit**: dcfd3af

### 3. Bootstrap job finds 0 peers (timing race)
- **Bug**: ArgoCD PostSync bootstrap job runs at apps-netbird sync time — before MetalLB and before
  router reconnects. Routing group (routing-peers-vlan3) stays empty.
- **Fix**: Added "Populate NetBird routing group after reconnect" step that polls the NetBird API
  after router reconnects and adds connected peers to routing-peers-vlan3 directly.
- **Commit**: 5833d61

### 4. Platform Users blueprint silently failed
- **Bug**: Leftover broken entry in blueprint-users.yaml (empty `identifiers:` from testuser cleanup)
  caused the entire "Platform Users Setup" blueprint to fail silently — remon/ardaty not created
- **Fix**: Removed the broken entry; added `apply_blueprint` via `BlueprintImporter.from_string()`
  as fallback in the workflow step
- **Commit**: e6a9f6d

### 5. kubectl exec stdin (pre-existing, already fixed)
- `kubectl exec pod -- command < file` does NOT forward stdin without `-i`
- Fix: use `cat file | kubectl exec -i pod -- ak shell`
- Or: write file into container, then `kubectl exec pod -- sh -c 'ak shell < /tmp/file'`

## Step Order in full-redeploy.yml (critical)
1. Deploy Platform (Terraform)
2. Save kubeconfig
3. Fix CoreDNS startup race
4. Deploy ArgoCD & Bootstrap (ArgoCD syncs apps → bootstrap job runs → finds 0 peers)
5. Bootstrap Storage
6. Bootstrap OpenBao + ExternalSecrets
7. Bootstrap ExternalSecrets + TLS Restore
8. Ensure Cloudflare DNS
9. **Apply MetalLB IP Pool + Traefik Middleware** ← MetalLB now active (10.10.0.202)
10. **Reconnect NetBird router VM** ← router reconnects (needs MetalLB active)
11. **Populate NetBird routing group** ← adds router to routing-peers-vlan3
12. Fix ingress-nginx
13. Patch CoreDNS
14. Set Authentik admin privileges (waits for Authentik worker + users)
15. Force-set user passwords
16. Send welcome emails
17. Configure OIDC
18. Run post-deploy tests
19. Refresh TLS backups
20. Send deployment summary

## Known Non-Issues (pre-existing)
- `external-routes: Degraded` — pre-existing, needs investigation
- `*-manifests apps: Unknown` sync status — SSA tracking annotation conflicts, harmless
- `monitoring-loki: Unknown` — Loki CRD tracking issue, harmless

## Verified Working After Full Redeploy (2026-05-04)
- ✅ All 29 workflow steps: SUCCESS
- ✅ remon: superuser=True, groups=[authentik Admins, platform-admins, platform-users]
- ✅ ardaty: superuser=False, groups=[platform-users]
- ✅ NetBird router peer: connected, in routing-peers-vlan3
- ✅ Routes: 10.10.0.0/24 and 10.25.0.0/24 active
- ✅ auth.rlservers.com: 200 OK
- ✅ netbird.rlservers.com: 200 OK
- ✅ All core pods: Running
