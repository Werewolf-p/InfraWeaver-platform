---
title: Deploy Failure Root Causes — Comprehensive Analysis May 2026
description: All known failure modes for InfraWeaver CI builds/deploys and their fixes.
---

# Deploy Failure Root Causes — Comprehensive Analysis

## Why Things Stop Working After or During a Deploy

### Failure Mode 1: Runner Disk Full (MOST COMMON)
- **Symptom:** Build fails at `Set up job` with `No space left on device: Worker_*.log`
- **Root cause:** Docker build cache, npm cache, and runner diagnostic logs fill `/` on the management host
- **Fix (implemented):** Pre-flight cleanup in both test and build jobs; daily `runner-cleanup.yml` workflow
- **Detection:** `df -h /` in pre-flight cleanup output in build logs

### Failure Mode 2: MetalLB Speakers Stuck in Init (CASCADE)
- **Symptom:** All builds fail with `dial tcp 10.10.0.200:443: connect: no route to host`. Registry and ALL ingress-routed services unreachable.
- **Root cause:** MetalLB speaker pods stuck in `Init:0/1` — Kyverno init container checking `127.0.0.1:6443` or HTTP healthz, both broken on Talos (API binds to node IP only; `--anonymous-auth=false` makes healthz return 401)
- **Fix (implemented):** Use `nc -z -w 5 <nodeIP> 6443` TCP port check in init container. Get nodeIP via `hostname -I` (valid in hostNetwork pods)
- **Recovery:** `kubectl delete pods -n metallb-system -l app.kubernetes.io/component=speaker` after fixing the policy
- **Detection:** `kubectl get pods -n metallb-system` — speakers in Init state

### Failure Mode 3: Stuck in Deployment Mode
- **Symptom:** API returns `503 Service is in deployment mode` for all mutations after a failed build
- **Root cause:** Build job sets `infraweaver-api-mode` ConfigMap to `deployment` but crashes before `Restore live mode` step runs
- **Why `if: always()` isn't enough:** If the runner HOST crashes (OOM, kernel panic), the cleanup steps never run
- **Mitigation:** The ConfigMap defaults to `live` if it doesn't exist (safe). If it exists with `deployment`, mutations are blocked until manually reset
- **Recovery:** `kubectl patch configmap infraweaver-api-mode -n infraweaver-console --patch '{"data":{"mode":"live"}}'`
- **Detection:** `curl https://api.int.rlservers.com/v1/mode` — check mode value

### Failure Mode 4: ArgoCD Sync Timeout During Rolling Update
- **Symptom:** Build workflow times out at "Force ArgoCD sync and wait for rollout"
- **Root cause:** New pod fails readiness probe (startup bug, slow Next.js cold start, missing secret)
- **Result:** Old pods stay running (`maxUnavailable: 0`), but build workflow times out at `progressDeadlineSeconds`; auto-rollback in workflow kicks in
- **Detection:** `kubectl describe deployment infraweaver-api -n infraweaver-console` — look for `ProgressDeadlineExceeded`

### Failure Mode 5: In-Cluster Registry Unavailable During Image Pull
- **Symptom:** New pods stuck in `ImagePullBackOff` after manifest update
- **Root cause:** `onedev.rlservers.com` → `10.10.0.200` (MetalLB VIP → Traefik → OneDev pod). If MetalLB or Traefik is disrupted after the image was pushed, new pods can't pull even though the image exists in the registry
- **Mitigation:** `imagePullPolicy: IfNotPresent` means if the image is already cached on the node from a previous pull, it won't re-pull. But new images (SHA-tagged) are never cached.
- **Detection:** `kubectl get pods -n infraweaver-console` — ImagePullBackOff events

### Failure Mode 6: Git Push Race During Simultaneous Builds
- **Symptom:** "Failed to push deployment manifest after N attempts" in build logs
- **Root cause:** API and console builds running simultaneously both try to push to the same branch
- **Mitigation:** Console build has 5-attempt fetch+reset+commit loop; API build has 3-attempt rebase loop. Different manifest files so conflicts are rare.
- **Improvement opportunity:** Consolidate into a single manifest-update job with proper locking

## Key Architecture Notes
- Registry: `onedev.rlservers.com` → MetalLB VIP `10.10.0.200` → Traefik → OneDev pod
- Traefik LB: Single replica, MetalLB L2 mode. If Traefik pod or MetalLB dies, ALL ingress including registry goes down
- Deployment mode ConfigMap: `infraweaver-api-mode` in namespace `infraweaver-console`
- Image tags: SHA-based (`main-XXXXXXX`), so `imagePullPolicy: IfNotPresent` always pulls on new deployments

## Quick Recovery Checklist
1. Speakers stuck? → Fix Kyverno policy, delete speaker pods
2. Registry down? → Check MetalLB speakers, Traefik pod
3. API in deployment mode? → Manually patch ConfigMap to `live`
4. Build failing disk? → Trigger `runner-cleanup.yml` manually then retry build
5. Pods in ImagePullBackOff? → Check registry availability, then `kubectl rollout restart`
