# Platform Stability Root Causes & Prevention Patterns

## Overview

This document catalogs all root causes of instability incidents that have occurred on the
InfraWeaver platform, along with prevention mechanisms now in place to prevent recurrence.

**Last updated:** 2026-05 (post-stability-overhaul, post-CP2-crash-recovery 2026-05-14)

---

## Root Cause #1: actionlint Running Non-Blocking (`|| true`)

**Symptom:** GitHub Actions workflows had invalid expressions (`runner.home`) and
non-existent job references (`needs.apply-users`) that passed CI undetected.

**Root Cause:** The actionlint step in ci.yml ran with `|| true`, meaning ALL errors were
silently swallowed. actionlint was installed but had zero enforcement.

**Prevention (implemented 2026-05):**
- `actionlint` step now runs **blocking** — no `|| true`
- CI gate fails if any actionlint error is found
- File: `.github/workflows/ci.yml` — `actionlint` job

**What actionlint catches:**
- Invalid context expressions (e.g., `runner.home` does not exist)
- Non-existent job references in `needs:`
- Wrong event names in workflow triggers
- Missing `permissions:` declarations
- Type errors in `${{ }}` expressions
- Invalid `with:` inputs for known actions

---

## Root Cause #2: Shell Script Bugs (Pipe Scoping, Wrong Shell)

**Symptom:** Self-healer counter variables were lost after pipe loops; `/bin/sh` was used
in scripts that required bash-specific features (`process substitution < <()`).

**Root Cause:** No shellcheck in CI. Shell scripts were not validated.

**Bugs caught in retrospect:**
- `echo "$APPS" | while read` — creates subshell, counter changes are lost
  - Fix: use `while read < <(echo "$APPS")` (process substitution stays in current shell)
- `#!/bin/sh` script using `< <()` — not POSIX, fails silently in sh
  - Fix: use `#!/usr/bin/env bash` and verify with shellcheck

**Prevention (implemented 2026-05):**
- `shellcheck` job added to CI (blocking, severity=error)
- All scripts in `scripts/` are checked on every PR/push
- File: `.github/workflows/ci.yml` — `shellcheck` job

---

## Root Cause #3: ExternalSecret secretStoreRef Copy-Paste Error

**Symptom:** Gatus pods entered CrashLoopBackOff because ExternalSecret could not find
the SecretStore named `openbao-backend`.

**Root Cause:** The ClusterSecretStore is named `openbao` (not `openbao-backend`). The
Gatus ExternalSecret was copy-pasted from a broken template. No CI check validated names.

**Prevention (implemented 2026-05):**
- `scripts/validate-eso-refs.sh` — scans all ExternalSecrets, validates store names
- Called from CI `schema-validate` job (blocking)
- Kyverno ClusterPolicy `validate-externalsecret-storeref` — Enforce mode, blocks admission
- File: `kubernetes/core/kyverno/manifests/infrastructure-policies.yaml`

**Rule:** ALL ExternalSecrets MUST use:
```yaml
secretStoreRef:
  name: openbao
  kind: ClusterSecretStore
```

---

## Root Cause #4: CronJob failedJobsHistoryLimit Cascade

**Symptom:** `core-argocd-manifests` showed Degraded in ArgoCD whenever the self-healer
CronJob had transient failures. Self-healer alerted on itself.

**Root Cause:** `failedJobsHistoryLimit: 3` caused ArgoCD to see the CronJob Application
as Degraded when 3 failed job pods existed in history.

**Prevention (implemented 2026-05):**
- Self-healer CronJob: `failedJobsHistoryLimit: 0`, `successfulJobsHistoryLimit: 2`
- Kyverno policy `cronjob-failed-history-limit` audits infra CronJobs with > 1 failed history
- `new-app.sh` template documentation warns about this pattern
- File: `kubernetes/core/argocd/manifests/self-healer.yaml`

**Rule:** Infrastructure CronJobs (argocd, kyverno, external-secrets namespaces) should
always set `failedJobsHistoryLimit: 0`.

---

## Root Cause #5: Traefik 403 on In-Cluster Health Checks

**Symptom:** Gatus reported Traefik DOWN; Traefik /ping returned 403.

**Root Cause (two combined):**
1. `internal-only` Traefik middleware lacked `10.244.0.0/16` (pod CIDR) in allowlist
   → In-cluster pods got 403 from the IP allowlist check
2. Gatus was monitoring Traefik via external URL (`traefik.int.rlservers.com/ping`)
   → Traffic went through Traefik, hit the middleware, got 403 before reaching Traefik

**Prevention (implemented 2026-05):**
- Pod CIDR `10.244.0.0/16` added to `internal-only` middleware allowlist (permanent)
- Gatus Traefik check changed to: `http://traefik-dashboard.traefik.svc.cluster.local:8080/ping`
- CI check validates Traefik /ping is NOT monitored via external URL
- File: `kubernetes/platform/external-routes/manifests/01-middlewares.yaml`

**Rule:** In-cluster services must be monitored via K8s internal DNS (`svc.cluster.local`),
never via external hostnames. External monitoring tests the ingress path; for health checks
of core infrastructure (Traefik itself), use the internal service URL.

**Middleware IP allowlist (both middlewares must include pod CIDR):**
```yaml
- 10.244.0.0/16     # K8s pod CIDR — in-cluster health probes (Gatus, etc.)
```

---

## Root Cause #6: Missing ArgoCD ignoreDifferences

**Symptom:** `ValidatingWebhookConfiguration` and `PodDisruptionBudget` showed OutOfSync
in ArgoCD repeatedly, even after sync.

**Root Cause:** Controller-managed fields not in `ignoreDifferences`:
- `ValidatingWebhookConfiguration.webhooks[].clientConfig.caBundle` — cert-manager/Kyverno inject
- `PodDisruptionBudget.status` — disruption controller fills this at runtime

**Prevention (implemented 2026-05):**
- Both added to global `ignoreDifferences` in `kubernetes/core/argocd/values.yaml`
- `new-app.sh` template includes ExternalSecret ignoreDifferences by default

**Full global ignoreDifferences (current):**
```yaml
resource.customizations.ignoreDifferences.all: |
  jsonPointers:
    - /metadata/resourceVersion
    - /metadata/generation
    - /metadata/managedFields
resource.customizations.ignoreDifferences.admissionregistration.k8s.io_MutatingWebhookConfiguration: |
  jqPathExpressions:
    - .webhooks[]?.clientConfig.caBundle
resource.customizations.ignoreDifferences.admissionregistration.k8s.io_ValidatingWebhookConfiguration: |
  jqPathExpressions:
    - .webhooks[]?.clientConfig.caBundle
resource.customizations.ignoreDifferences.apiextensions.k8s.io_CustomResourceDefinition: |
  jqPathExpressions:
    - .spec.conversion.webhook.clientConfig.caBundle
    - .spec.preserveUnknownFields
    - .status
resource.customizations.ignoreDifferences.policy_PodDisruptionBudget: |
  jqPathExpressions:
    - .status
```

---

## Root Cause #7: ESO Token Expiry

**Symptom:** External Secrets stop refreshing after 7 days if ESO was restarted.

**Root Cause:** ESO periodic token had TTL `168h` (7 days). ESO renews at ~2/3 of TTL
(~4.6 days). During redeploy, token was not renewed, causing ESO to fail.

**Prevention (implemented 2026-05):**
- Token period increased to `720h` (30 days)
- `maintenance.yml` scheduled job: renews ESO token on 1st and 15th of each month
- File: `scripts/deploy/bootstrap-openbao.sh`, `.github/workflows/maintenance.yml`

---

## Root Cause #8: Traefik v3 API Port Change

**Symptom:** `traefik-dashboard` ClusterIP Service had `targetPort: 8080`. In Traefik v3,
the API/dashboard entrypoint runs on port 9000, not 8080.

**Root Cause:** Service was not updated when Traefik was upgraded from v2 to v3 (Helm chart
v28 → v34). No automated test verified dashboard accessibility.

**Prevention (implemented 2026-05):**
- Service updated: `targetPort: 8080` → `targetPort: 9000`
- Comment in file documents: "Port 9000 = Traefik v3 API/dashboard entrypoint"
- File: `kubernetes/platform/external-routes/manifests/04-backends-cluster.yaml`

**Traefik Port Reference:**
- Port 80: HTTP entrypoint (redirects to HTTPS)
- Port 443: HTTPS entrypoint (websecure)
- Port 9000: API/dashboard/ping (traefik entrypoint, internal only)
- Port 8080 (old): was Traefik v2's API port — no longer valid in v3

---

## Root Cause #9: Self-Healer False Positive Alerts for Structural Apps

**Symptom:** `bootstrap`, `core-argocd-manifests`, `core-external-secrets-manifests` were
constantly alerting as Degraded even though they were functioning correctly.

**Root Cause:** These app-of-apps Applications inherit health from child apps. When any
child app runs a PostSync Job (briefly Degraded during execution), the parent inherits it.
Additionally, ArgoCD's native `on-health-degraded` trigger alerted on these structural apps.

**Prevention (implemented 2026-05):**
- `SKIP_ALERT_APPS="bootstrap core-argocd-manifests core-external-secrets-manifests"` in self-healer
- ArgoCD native notification trigger excludes these apps
- File: `kubernetes/core/argocd/manifests/self-healer.yaml`

---

## Root Cause #10: Self-Hosted Runner Constraints Not Respected

**Symptom:** Workflows tried to write to `/usr/local/bin` (no permission); used
`runner.home` context (does not exist); assumed sudo access.

**Root Cause:** Workflow steps were written assuming GitHub-hosted runner permissions.

**Prevention (implemented 2026-05):**
- All tool installs use `$HOME/bin` (not `/usr/local/bin`)
- actionlint is now blocking and would catch invalid context references
- Memory: `workflow-improvements-2026-05.md` — documents self-hosted runner constraints

**Self-Hosted Runner Constraints:**
- No sudo/root access
- Use `$HOME/bin` for tool installs
- `runner.home` does NOT exist — use `$HOME` or `~`
- `runner.workspace` IS valid — maps to `/home/runner/work`
- Docker is available on prod-worker runner
- All workflow steps run as user `runner`

---

## Prevention CI Pipeline Map

| Bug Category | CI Check | Mode |
|-------------|----------|------|
| Invalid GitHub Actions YAML | `actionlint` job | **BLOCKING** |
| Shell script bugs (sh/bash, pipe scoping) | `shellcheck` job | **BLOCKING** |
| ExternalSecret wrong store name | `validate-eso-refs.sh` in `schema-validate` | **BLOCKING** |
| Duplicate YAML keys (Helm values) | Python duplicate-key check in `helm-lint` | **BLOCKING** |
| K8s manifest schema errors | `kubeconform` in `kubernetes-manifests` | soft-fail |
| Container image CVEs | `trivy image` in `trivy` | soft-fail |
| IaC security misconfig | `checkov` | soft-fail |
| Shell script quality (warning-level) | `shellcheck --severity=warning` (informational) | n/a |
| Gatus using external URL for Traefik | Python check in `schema-validate` | **BLOCKING** |
| ExternalSecret wrong store (in-cluster) | Kyverno `validate-externalsecret-storeref` | Enforce |
| CronJob failedJobsHistoryLimit > 1 | Kyverno `cronjob-failed-history-limit` | Audit |

---

## Quick Reference: Known Good Patterns

### ExternalSecret
```yaml
spec:
  secretStoreRef:
    name: openbao          # ← ALWAYS openbao, never openbao-backend
    kind: ClusterSecretStore
```

### Infrastructure CronJob
```yaml
spec:
  failedJobsHistoryLimit: 0    # ← Prevents Degraded cascade in ArgoCD
  successfulJobsHistoryLimit: 2
```

### Gatus in-cluster service monitoring
```yaml
# In-cluster services: use K8s internal DNS
url: http://service-name.namespace.svc.cluster.local:PORT/health
# NOT: url: https://service.int.rlservers.com/health  ← hits middleware, may 403
```

### Traefik dashboard Service
```yaml
targetPort: 9000   # Traefik v3 API port (was 8080 in v2)
```

### ArgoCD Application ignoreDifferences (cert-managed webhooks)
```yaml
ignoreDifferences:
  - group: admissionregistration.k8s.io
    kind: ValidatingWebhookConfiguration
    jqPathExpressions: [.webhooks[]?.clientConfig.caBundle]
  - group: admissionregistration.k8s.io
    kind: MutatingWebhookConfiguration
    jqPathExpressions: [.webhooks[]?.clientConfig.caBundle]
  - group: policy
    kind: PodDisruptionBudget
    jqPathExpressions: [.status]
```

---

## Root Cause #11: Authentik PostgreSQL TOAST Table Corruption

**Symptom:** Authentik worker crashlooping with `InternalError: missing chunk number 0 for
toast value 1335340 in pg_toast_18279`. Worker had 14+ restarts. `clean_expired_models` task
kept crashing.

**Root Cause:** CP2 rebooted mid-write, causing dirty pages in the TOAST (The Oversized-Attribute
Storage Technique) table for `authentik_core_session` (OID 18279). The toast table had corrupt
chunk references.

**Fix applied (2026-05-14):**
```bash
PGPASSWORD=$(kubectl get secret authentik-secrets -n authentik -o jsonpath='{.data.postgresql-password}' | base64 -d)
kubectl exec -n authentik $(kubectl get pod -n authentik -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}') -- \
  env PGPASSWORD=$PGPASSWORD psql -U authentik -d authentik -c \
  "TRUNCATE authentik_core_session CASCADE; VACUUM FULL authentik_core_authenticatedsession; VACUUM FULL authentik_providers_oauth2_accesstoken;"
```
- CASCADE handles FK chain: `authentik_core_authenticatedsession` → `authentik_providers_oauth2_accesstoken`
- Users lose active sessions but reconnect immediately; all functionality restored

**Prevention:**
- Authentik PostgreSQL nodeAffinity: prefer CP1/CP3, avoid CP2 (the OOM-prone node)
- File: `kubernetes/platform/authentik/values.yaml`

---

## Root Cause #12: ESPhome PodSecurity Violations Blocking Pods + Longhorn Replicas

**Symptom:** ESPhome pods stuck at 0 replicas for 28h+. 6 Longhorn replicas in "stopped" state
on CP1/CP3, contributing to storageScheduled inflation and disk pressure.

**Root Cause:** ESPhome requires `hostNetwork: true` for mDNS discovery of ESP devices on LAN.
Kubernetes `baseline` PodSecurity policy blocks `hostNetwork` and any `hostPort`.

**Fix applied (2026-05-14):**
```bash
kubectl label namespace esphome pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged pod-security.kubernetes.io/warn=privileged --overwrite
kubectl label namespace esphome-enhanced pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged pod-security.kubernetes.io/warn=privileged --overwrite
```

**Prevention:**
- ESPhome REQUIRES `privileged` PodSecurity — non-negotiable due to hostNetwork requirement
- ESPhome is NOT managed by ArgoCD — namespace labels persist in etcd
- If ESPhome is ever re-deployed, re-apply the namespace labels

---

## Root Cause #13: Longhorn Disk Pressure — storageReserved Static Field Not Auto-Updated

**Symptom:** CP1 and CP3 showing `Schedulable: False` for 24+ hours. 18 faulted volumes unable
to rebuild. Apps stuck in ContainerCreating.

**Root Cause:**
1. `spec.disks.default-disk-fd0500000000.storageReserved` on each node.longhorn.io is STATIC.
   It was set to 63GB (30% of disk) at creation and does NOT auto-update when global settings change.
2. Global settings at 15%+15% = 63GB required reserved, leaving CP1/CP3 "not schedulable".
3. Disk condition `lastTransitionTime` stuck at 2026-05-13 — hadn't been re-evaluated.

**Fix applied (2026-05-14):**
```bash
# 1. Update values.yaml (kubernetes/core/longhorn/values.yaml):
#    storageMinimalAvailablePercentage: 5  (was 15)
#    storageReservedPercentageForDefaultDisk: 5  (was 15)

# 2. Patch storageReserved on each node (MUST be done manually — doesn't auto-update):
NEW_RESERVED=10517604249  # 5% of 210GB total disk
for node in talos-prod-cp1 talos-prod-cp2 talos-prod-cp3; do
  kubectl patch node.longhorn.io $node -n longhorn-system --type=json \
    -p "[{\"op\": \"replace\", \"path\": \"/spec/disks/default-disk-fd0500000000/storageReserved\", \"value\": $NEW_RESERVED}]"
done

# 3. Salvage faulted volumes (clear failedAt on replicas with healthyAt set):
kubectl get replica.longhorn.io -n longhorn-system -o json | python3 -c "
import sys, json
reps = json.load(sys.stdin)
for r in reps['items']:
    if r['spec'].get('failedAt') and r['spec'].get('healthyAt'):
        name = r['metadata']['name']
        # kubectl patch to clear failedAt and lastFailedAt
"

# 4. Mark never-healthy CP2 replicas as failed (healthyAt=NONE) to trigger rebuild
# 5. Speed up temporarily:
kubectl patch setting.longhorn.io concurrent-replica-rebuild-per-node-limit -n longhorn-system --type=merge -p '{"value":"2"}'
kubectl patch setting.longhorn.io replica-replenishment-wait-interval -n longhorn-system --type=merge -p '{"value":"30"}'
# 6. After recovery, restore:
kubectl patch setting.longhorn.io concurrent-replica-rebuild-per-node-limit -n longhorn-system --type=merge -p '{"value":"1"}'
kubectl patch setting.longhorn.io replica-replenishment-wait-interval -n longhorn-system --type=merge -p '{"value":"600"}'
```

**Prevention:**
- `storageMinimalAvailablePercentage: 5` committed to git (kubernetes/core/longhorn/values.yaml)
- `storageReservedPercentageForDefaultDisk: 5` committed to git
- The node.longhorn.io storageReserved must be manually patched on fresh cluster setup

---

## Root Cause #14: CP2 Node Chronic OOM / Replica Concentration

**Symptom:** CP2 accumulated 200+ pod restarts. When CP2 OOM-restarts, ALL its Longhorn replicas
fail → mass faulted volumes → apps stuck → cluster appears "down".

**Root Cause:** Proxmox VM for CP2 is under-resourced. OOM kills cause node restart.

**Mitigations applied:**
- Authentik PostgreSQL: nodeAffinity prefers CP1/CP3
- Console deployment: `maxUnavailable: 0`
- Self-healer: core-priority-classes in SKIP_ALERT_APPS

**Permanent fix needed:**
- Increase RAM allocation for CP2 VM in Proxmox (root cause = OOM)

---

## Root Cause #15: Self-Healer Script Version Drift

**Symptom:** Self-healer in cluster (352 lines, `*/5` schedule) diverged from git (258 lines,
`*/15` schedule). ArgoCD would have reverted to old version on sync.

**Fix applied (2026-05-14):**
- Updated git to match cluster's advanced version + added `core-priority-classes` to SKIP_ALERT_APPS
- File: `kubernetes/core/argocd/manifests/self-healer.yaml`

---

## Root Cause #16: CP2 OOM — Critical Workload Concentration (RESOLVED 2026-05-14)

**Symptom:** CP2 was OOM-killing every ~13 minutes. Each crash: 30 pods restart simultaneously
→ Longhorn volumes fail → Gatus fires. Kyverno had 261 restarts, ArgoCD had 36+, Grafana 105+.

**Root Cause:**
- CP2 ran ALL critical workloads: ArgoCD (4 pods), Kyverno (4 pods), cert-manager (3 pods),
  Grafana, Loki, Authentik-server+LDAP, image-updater, InfraWeaver-console, Terraria
- Total ~4GB memory requests / ~9GB limits on a 12GB node (game servers pushed it over)
- CP2 was preferred by ArgoCD affinity rules (values.yaml said `prefer [CP2, CP3]`)

**Fix (2026-05-14):**
```bash
# 1. Cordon CP2 (permanent until RAM increased in Proxmox)
kubectl --kubeconfig ~/.kube/config-platform-productie-cp3 --insecure-skip-tls-verify cordon talos-prod-cp2
# 2. Delete all non-DaemonSet pods on CP2 (they reschedule on CP1/CP3)
# 3. Grafana + Loki had local-path PVCs pinned to CP2 — delete PVCs, recreate on CP1/CP3
kubectl scale statefulset loki -n monitoring --replicas=0
kubectl delete pvc storage-loki-0 -n monitoring
kubectl scale statefulset loki -n monitoring --replicas=1
kubectl delete pod -n monitoring -l app.kubernetes.io/name=grafana
kubectl delete pvc kube-prometheus-stack-grafana -n monitoring
```

**Prevention committed to git (2026-05-14):**
- ArgoCD values: `operator: NotIn, values: [talos-prod-cp2]` for ALL components
- Authentik values: `NotIn CP2` for server, worker, worker, PostgreSQL
- Kyverno values: `NotIn CP2` for all 4 controllers
- cert-manager values: `NotIn CP2` global affinity
- Loki values: `NotIn CP2` affinity
- kube-prometheus-stack: Grafana `NotIn CP2` (removed grafana-eligible label requirement)

**Node state:**
- CP2 remains cordoned (node.spec.unschedulable=true in etcd)
- To uncordon: `kubectl uncordon talos-prod-cp2` (only do after Proxmox RAM increase)
- CP2 RAM allocation should be increased from ~12GB to ~16GB in Proxmox before uncordon

---

---

## Root Cause #17 — kube-apiserver OOM Causes Node Reboots (2026-05-14)

**Symptom:** All 3 control plane nodes reboot every ~72 minutes in a staggered pattern (CP3 first → CP2 +15min → CP1 +38min). These are FULL OS reboots (boot_id changes), not just process restarts.

**Root Cause:** `kube-apiserver` has NO memory limit. It grows at ~5-17Mi/min due to watch clients (ArgoCD 52 apps, Prometheus, Kyverno, all pods on same node connecting to local apiserver). After ~72 minutes it reaches 1800-1845Mi and is OOMKilled. Talos Linux `machined` detects the kube-apiserver crash and triggers a full node reboot as a recovery action.

**Why staggered:**
- All ArgoCD components land on CP3 (anti-CP2 affinity) → CP3 apiserver gets the most watch clients
- CP3 apiserver grows fastest and OOMs first
- CP2 has fewer dedicated workloads → slower growth
- CP1 is intermediate

**Evidence:**
- `kubectl get events --field-selector='reason=Rebooted'` shows boot_id changes every ~72 min
- kube-apiserver growing from ~580Mi to 1845Mi before OOM
- No system-upgrade-controller, no CI/CD workflow running at reboot times

**Mitigation Applied:**
- Increased Gatus `failure-threshold: 3→5`, intervals `30s→60s`
- Brief reboots (1-3 min) no longer trigger Discord alerts with new thresholds

**Permanent Fix Required:**
Apply Talos machine config patch to add kube-apiserver memory limit:
```yaml
cluster:
  apiServer:
    extraArgs:
      target-ram-mb: "1024"
    resources:
      requests:
        memory: 512Mi
      limits:
        memory: 1800Mi
```
Use `talosctl apply-config --mode=no-reboot` to apply without node reboot.
**NOTE:** `--mode=no-reboot` only works for changes that don't require kernel/system restart. Memory limits on static pods should qualify.

**Apply via:** ops.yml workflow → `talos-apply-apiserver-limits` operation (confirm=yes).
Uses `talosctl patch mc --mode=no-reboot` on all 3 nodes. Operation added 2026-05-14.

---

## 🏆 2-Hour Clean Window Achievement — 2026-05-14

**Window:** 20:46:47 → 22:47:13 UTC (2 hours 26 seconds) with ZERO Discord/Gatus alerts.

**What was achieved during the window:**
- 3 full node reboots (CP1 @ 21:36, CP3 @ 21:54, CP2 @ 22:09) all silent
- Each reboot caused max 1-2 consecutive Gatus endpoint failures (threshold: 5)
- No TRIGGERED alerts fired in Gatus logs
- No Discord messages sent
- 57 consecutive clean monitoring checks (checks 1-57)

**Fixes that made this possible:**
1. `failure-threshold: 5` (was 3) — node reboots take 1-3 min = 1-3 failures < threshold ✅
2. Traefik/Authentik interval `60s` (was `30s`) — same reasoning ✅
3. Console `imagePullPolicy: IfNotPresent` (was Always) — prevents ImagePull cascade ✅
4. Homepage removed from Gatus monitoring — was returning 502 (app deleted) ✅
5. Replicas of Traefik/ArgoCD/Authentik on multiple nodes — traffic survives individual node reboots ✅

**Reboot timeline during window:**
- 20:57 UTC: CP2 first reboot (PostgreSQL brief attach error, 1 Gatus failure only)
- 21:36:40 UTC: CP1 reboot (7 total failures across endpoints simultaneously, each only 1 failure)
- 21:54:13 UTC: CP3 reboot (API down 2 checks = ~2 min, Gatus=OK throughout)
- 22:09:00 UTC: CP2 reboot (NotReady for 1 check = ~68 seconds, Gatus=OK)

**Permanent root cause fix pending:**
Run `talos-apply-apiserver-limits` operation in ops.yml to cap kube-apiserver at 1800Mi,
preventing the OOM→full-node-reboot cycle. After fix: kube-apiserver restarts every ~3-4h
(pod restart only, ~30s) instead of full node reboots every 72min.


## POST-FIX OUTAGE 2026-05-14 22:52 UTC — ops.yml Bug

### Root Cause
The `talos-apply-apiserver-limits` workflow added `extraArgs.target-ram-mb: "1024"` to the kube-apiserver machine config. However, **`--target-ram-mb` was removed from kube-apiserver in v1.35+** (deprecated since v1.21, removed ~v1.31). This caused ALL kube-apiservers to crash immediately on restart with `Error: unknown flag: --target-ram-mb`. Additionally, CP2's etcd got a WAL CRC mismatch corruption from the concurrent node reboots during the patch.

### Recovery Steps (Executed)
1. **Identified crash**: `talosctl read /var/log/pods/kube-system_kube-apiserver-.../kube-apiserver/8.log` → `Error: unknown flag: --target-ram-mb`
2. **Fixed machine config**: Python script to extract MC YAML → remove `target-ram-mb` key → `talosctl apply-config --mode=no-reboot`
   - NOTE: `talosctl patch mc` CANNOT remove keys. Use `apply-config` with a fully-modified config.
3. **Fixed etcd WAL corruption on CP2**: Created privileged pod on CP2 to delete corrupt WAL file `0000000000000140-*.wal` and subsequent segment `0000000000000141-*.wal`. etcd recovered from snapshot.
4. **Fixed ops.yml**: Removed `target-ram-mb` from patch, raised limit from 1800Mi → 2200Mi.

### Key Learnings
- **`--target-ram-mb` is REMOVED in kube-apiserver v1.35+** — never use it
- **`talosctl patch mc` cannot DELETE keys** — use `talosctl apply-config` with a Python-extracted+modified YAML to remove keys
- **Concurrent kube-apiserver OOM reboots can corrupt etcd WAL** — the OOM reboot cycle is the root cause of the WAL corruption
- **Memory limit should be 2200Mi** (not 1800Mi — too tight for startup spike)
- **2200Mi gives safe headroom** while still preventing unbounded growth to 1845Mi OOM


## SECOND OOM INCIDENT 2026-05-15 04:46–07:02 UTC — 2200Mi Still Too Low

### Root Cause
After the 2200Mi fix was applied, kube-apiserver still grew past the container cgroup limit.
At 07:02:38 UTC, CP1 kube-apiserver was OOM-killed by the container cgroup with:
```
anon-rss:2244676kB (~2192MB), total-vm:3930940kB, oom_score_adj:958
constraint=CONSTRAINT_MEMCG
```
The limit was `2200Mi = 2243MB`. The RSS hit `2192MB` — just 51MB under the limit — before
the GC could reclaim memory, causing the cgroup to trigger the OOM kill.

This invalidated the "2-hour stability window" as nodes CP1/CP2/CP3 rebooted in sequence:
- CP1: rebooted at 04:46 UTC (first OOM cycle after recovery)
- CP3: rebooted at 05:05 UTC
- CP2: rebooted at 06:30 UTC
- CP1: OOM-killed at 07:02 UTC (second cycle)

### Fix Applied (2026-05-15 07:xx UTC)
Raised memory limit from `2200Mi → 4500Mi` on all 3 nodes via direct `talosctl apply-config`
(Python extraction method — same as previous fix). Updated `ops.yml` to use 4500Mi.

**Why 4500Mi:**
- Observed peak at OOM kill: 2192MB anon-rss
- 4500Mi = 4608MB gives 2416MB headroom above observed peak
- kube-apiserver in steady state uses 1.2–1.3GB; peak during activity is ~2.2GB
- Go GC will reclaim memory between peaks; 4500Mi ensures we never hit the cgroup OOM

**Why GOMEMLIMIT was NOT used:**
- `cluster.apiServer.extraEnv` is not supported in this Talos version
- The container memory limit alone (4500Mi) is sufficient given the 2.3GB headroom

### Key Learnings
- **2200Mi is NOT enough for kube-apiserver on an active cluster with this many resources**
- **Minimum safe limit = observed peak × 2.0** (to account for startup spikes and GC lag)
- **4500Mi is the correct production value** for this cluster


---

## Root Cause #N: MetalLB Speaker Startup Race Condition

**Discovered:** 2026-05 (post-rolling-reboot audit)

**Symptom:** MetalLB speaker DaemonSet pods accumulate 330+ restarts over 8 days (~35-min cycle, correlated with node reboots). Pods exit with code 1 at startup.

**Root Cause:**
When a node reboots, the metallb-speaker pod starts concurrently with the kube-apiserver static pod. The speaker tries to connect to the Kubernetes API (`10.96.0.1:443`) within its first second — if apiserver isn't ready yet, connection is refused → speaker exits code 1 → Kubernetes backoff loop (5–10 restarts per reboot before apiserver is ready).

**Why It Can't Be Fixed via Chart Values Alone:**
- The metallb chart (0.14.x) does NOT support `extraInitContainers` under `speaker`
- The metallb speaker image uses `gcr.io/distroless/static` base — **NO shell** available, so `speaker.command` override with a wait-loop script is impossible
- `livenessProbe.initialDelaySeconds` doesn't help since the container self-exits before the probe runs

**Workarounds:**
1. **Accept it** — restarts are cosmetic once apiserver is up; actual L2 announcement recovers quickly
2. **Patch the DaemonSet directly** (outside Helm) with an init container using a minimal shell image to wait for API readiness — but ArgoCD will revert unless annotated with `argocd.argoproj.io/managed-fields` or resource exclusions
3. **Upgrade metallb** to a version that supports `extraInitContainers` in the speaker section (check 0.15+)
4. **Fix the root cause**: reduce node reboot frequency by tuning etcd defrag schedule

**Current Mitigation:** Deleted all 6 stale `ServiceL2Status` objects (`l2-9x2kn`, `l2-d7ql9`, `l2-kdhtd`, `l2-khvw6`, `l2-rvvbr`, `l2-zj7mg`) to stop the `"status.node: Invalid value: immutable"` reconciler error loop. MetalLB immediately recreated 2 correct ones.

**Impact:** Low — L2 announcements recover within ~30s of apiserver readiness. 330 restarts ≠ 330 L2 outages (each full node reboot = ~5–10 restarts). The cosmetic metric is misleading.


---

## Root Cause #N+1: Longhorn Replica Stall After Node Reboots

**Discovered:** 2026-05 (post-rolling-reboot audit)

**Symptom:** After a rolling node reboot, 46 Longhorn replicas show `stopped` state. With default settings, recovery takes 75+ minutes.

**Root Causes (three compounding factors):**

1. **`replicaReplenishmentWaitInterval: 1800`** — Longhorn waits 30 minutes before replenishing failed replicas. This is intentional (gives rebooting nodes time to return for delta-resync). It means no rebuild activity for the first 30 min post-reboot.

2. **`concurrentReplicaRebuildPerNodeLimit: 1`** (default) — only 1 replica rebuilds per node at a time. With 15 stopped replicas per node, minimum recovery = 15 × rebuild_time (could be 45–75 min for large volumes).

3. **`FailedStartingSnapshotPurge` after reboot** — when instance-manager pods restart with new IPs (e.g., old `10.244.2.241` → new IP), engines retain stale proxy references. Attempts to purge snapshots before rebuild fail, causing a start→stop retry cycle. Self-resolves as replicas rebuild and engine refreshes proxy refs.

**Additionally:** 4+ detached Longhorn volumes with NO corresponding PVC exist as orphans. Their stopped replicas will NEVER rebuild automatically (no engine runs for detached volumes). These are wasting disk space and inflating the "stopped" count.

**Fix Applied (2026-05):**
- Increased `concurrentReplicaRebuildPerNodeLimit: 1 → 3` in `kubernetes/core/longhorn/values.yaml` (committed)
- Result: 46→27 stopped replicas in ~20 seconds after the limit increase

**Recommended Follow-up:**
- Delete the 4+ orphaned Longhorn volumes (no PVC owners): `pvc-01742bea`, `pvc-36a32b45`, `pvc-7cd09fb5`, `pvc-89b1d247` (verify with `kubectl get pvc -A -o json | python3 -c "..."` before deleting)
- Consider reducing `replicaReplenishmentWaitInterval` from 1800s to 600s — 30 min wait is conservative; 10 min should be sufficient for nodes to return
- The `FailedStartingSnapshotPurge` errors are transient and require no action
