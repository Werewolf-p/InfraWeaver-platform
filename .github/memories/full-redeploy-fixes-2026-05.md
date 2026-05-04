# Full Redeploy Root Causes & Fixes — 2026-05

## Session: Full testing + optimization (2026-05-04)

### Critical bugs found and fixed

#### 1. YAML structural bug in full-redeploy.yml (commit d942c8d)
- **Root cause**: "Fix ingress-nginx admission webhook" had no `- name:` declaration
- **Effect**: The step was embedded as a duplicate `run:` inside "Populate NetBird routing group"
  step. In YAML, duplicate keys are technically invalid; Go's yaml.v3 kept the FIRST `run:`
  (routing group code) and discarded the ingress-nginx patching code entirely.
- **Fix**: Added proper `- name: Fix ingress-nginx admission webhook` step declaration

#### 2. Python at column-0 in YAML block scalars (commit b3365a7, historical)
- Python code at column 0 inside `run: |` terminates the YAML block scalar
- GitHub parsed the file as invalid → silently ignored `workflow_dispatch` trigger → HTTP 422
- **Fix**: Use one-liner python3 -c; use `printf` instead of heredocs at col 0

#### 3. Router reconnect ordering (commit dcfd3af, historical)
- Router reconnect ran BEFORE MetalLB — management VIP 10.10.0.202 not yet available
- **Fix**: Move router reconnect AFTER Apply MetalLB

#### 4. Routing group populate timing race (commit 5833d61, historical)
- ArgoCD PostSync bootstrap job runs at apps-netbird sync time (before MetalLB)
- Bootstrap job configures groups/routes but finds 0 peers → group empty
- **Fix**: Dedicated "Populate NetBird routing group after reconnect" step after router reconnect

#### 5. Blueprint broken empty identifiers (commit e6a9f6d, historical)
- blueprint-users.yaml had a stray entry with empty `identifiers:` (null username)
- Authentik blueprint failed silently → users not created after redeploy
- **Fix**: Remove broken entry

#### 6. kubectl exec stdin (commit 773cfa4, historical)  
- `kubectl exec pod -- command < /tmp/file` does NOT forward stdin without `-i`
- **Fix**: Use `cat file | kubectl exec -i pod -- ak shell` for group sync

### New features added (2026-05-04)

#### Staging Let's Encrypt support
- Added `letsencrypt-http-staging` and `letsencrypt-cloudflare-staging` ClusterIssuers
- Added `letsencrypt_env` workflow_dispatch input (staging/production, default=production)
- Added "Configure certificate issuers" step to patch cert issuerRefs when staging selected
- TLS backup step skipped when using staging (certs not LE-trusted, not worth backing up)

### Test results (2026-05-04)

| Test | Result | Notes |
|------|--------|-------|
| T01: Sync change | ✅ PASS | ArgoCD synced homepage, NetBird router stayed connected |
| T02: NetBird re-sync | ✅ PASS | apps-netbird re-sync, bootstrap job ran, router stayed in group |
| T03: User modify | ✅ PASS | apply-changes.yml success, group sync correct |
| T04: User add | ✅ PASS | testuser2 created with correct password, groups, blueprint |
| T07: Staging LE | ✅ in progress | Staging redeploy triggered |
| T10: Prod LE | pending | After staging test |

### Performance notes
- Authentik worker wait is typically 10-15 min (already optimal: `kubectl wait --for=condition=Available`)
- TLS cert wait (15 min max) is usually < 5 min because certs issued much earlier during redeploy
- Routing group populate: polls every 5s for up to 90s after router reconnect
- Total redeploy time: ~35-45 minutes

### Static IDs (hardcoded in bootstrap-job.yaml)
- Account: `acc00000-0000-4000-a000-000000000001`
- All group: `grp00000-0000-4000-a000-000000000001`
- Routing group: `grp00000-0000-4000-a000-000000000002`
- Setup key: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
- Router VM: `10.10.0.10` (ubuntu user), management VIP: `10.10.0.202`
- PAT token: `netbird-secrets` secret, key `netbird-pat-token` in namespace `netbird`

### NetBird management API
- Port 80: HTTP management REST API
- Port 33073: gRPC (not usable for REST)
- kubectl port-forward to pod (StatefulSet): `kubectl port-forward -n netbird netbird-management-0 8089:80`
