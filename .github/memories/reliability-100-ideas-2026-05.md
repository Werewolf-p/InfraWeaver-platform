---
title: Cluster Reliability — 100 Ideas & Implementation Plans
description: Reliability hardening backlog and implemented improvements for the InfraWeaver Talos homelab cluster
generated: 2026-05
branch: feat/reliability
---

# Cluster Reliability — 100 Ideas & Implementation Plans

> Scope: 3-node Talos control-plane cluster, ArgoCD GitOps, Longhorn storage, Traefik ingress, InfraWeaver console.
> Terraform note: the requested kubelet eviction thresholds, kube-reserved, and system-reserved settings were already present in `terraform/modules/talos-cluster/main.tf` on this branch baseline and were verified rather than re-added.

## Implemented or verified in `feat/reliability`
- Verified kubelet eviction thresholds and reservations already exist in Terraform.
- Verified PDBs already exist for Authentik, ArgoCD server, Traefik, and InfraWeaver console.
- Verified Longhorn recurring backup jobs and stale replica cleanup automation already exist.
- Verified ArgoCD self-healer CronJob configuration is present and scheduled.
- Implemented Longhorn backup opt-in annotations for remaining `longhorn-retain` PVCs.
- Implemented Prometheus OOM / MemoryPressure / PodOOMKilled alerts.
- Implemented preferred game-server node affinity toward `talos-prod-cp2`.
- Implemented reliability score API endpoint.
- Implemented PDB status API + cluster page view.
- Implemented Longhorn backup status API + storage page view.

---

## 1. Node stability (ideas 1–20)

### 1. Verify kubelet eviction thresholds via Terraform — VERIFIED
**Plan:** Keep `terraform/modules/talos-cluster/main.tf` as source of truth, validate with `tofu validate`, and call out that settings are present but still require apply/reconcile tracking.

### 2. Verify `kube-reserved` and `system-reserved` memory — VERIFIED
**Plan:** Keep `memory=2Gi` and `memory=512Mi` in Terraform, then confirm effective kubelet args on all Talos nodes after next cluster reconcile.

### 3. Track Terraform apply drift for Talos kubelet args
**Plan:** Add an operator checklist item or post-merge note to confirm changed kubelet args reached all control-plane nodes after Talos config rollout.

### 4. Add node memory pressure dashboard
**Plan:** Expose per-node allocatable vs used memory, eviction thresholds, and recent OOM events in Grafana and the console.

### 5. Add Talos node config conformance check
**Plan:** Periodically compare live Talos machine configs to Terraform-rendered intent and alert on drift in kubelet settings.

### 6. Reserve CPU explicitly for system daemons
**Plan:** Extend existing kube/system reserved config review to CPU starvation, verify Talos and kubelet still retain stable scheduling headroom.

### 7. Add node labels for workload segregation
**Plan:** Label nodes by intended role (`platform-preferred`, `game-preferred`, `storage-preferred`) and bind critical workloads to stable nodes.

### 8. Add taints for memory-sensitive platform nodes
**Plan:** Taint one node for platform-critical services and add only required tolerations to Authentik, ArgoCD, and ingress.

### 9. Prefer game servers onto `talos-prod-cp2` — IMPLEMENTED
**Plan:** Use `preferredDuringSchedulingIgnoredDuringExecution` node affinity so games bias away from nodes favored by ArgoCD/Auth without creating a hard single-node dependency.

### 10. Add platform anti-affinity review for all critical Deployments
**Plan:** Audit Authentik, ArgoCD, Traefik, Grafana, and console workloads to ensure replicas spread across nodes whenever replicas >1.

### 11. Tune PriorityClasses for eviction order
**Plan:** Keep platform workloads above game workloads so kubelet evicts low-priority game pods first under pressure.

### 12. Add admission policy for missing memory limits
**Plan:** Use Kyverno to warn or deny pods in critical namespaces when limits/requests are missing or obviously unsafe.

### 13. Add burst-budget policy for game servers
**Plan:** Gate game-server memory limits so aggregate worst-case memory cannot overcommit the cluster beyond safe headroom.

### 14. Add node swap/no-swap validation
**Plan:** Verify Talos swap remains disabled and alert if node memory accounting or kubelet flags ever drift from expected settings.

### 15. Add node reboot guardrail window
**Plan:** Create a maintenance label or schedule so planned node reboots only happen during low-load windows and not during backup/sync peaks.

### 16. Add node health SLO
**Plan:** Track `% Ready time` per node over 30d, plus frequency of MemoryPressure and NotReady transitions.

### 17. Add control-plane pod static resource inventory
**Plan:** Capture real kube-apiserver/etcd/controller-manager usage and re-check reserved memory sizing quarterly.

### 18. Add kubelet eviction test runbook
**Plan:** Document how to simulate pressure safely and verify graceful pod eviction instead of kernel OOM kills.

### 19. Add automatic cordon when repeated OOMs occur
**Plan:** Trigger a bounded automation if a node records repeated OOM kills within a short window, then drain only migratable workloads.

### 20. Add node aging / reboot debt report
**Plan:** Surface node uptime, kernel age, and pending maintenance debt to avoid long-lived nodes accumulating hidden risk.

## 2. Longhorn reliability (ideas 21–40)

### 21. Keep recurring TrueNAS backup jobs in Git — VERIFIED
**Plan:** Retain `backup-jobs.yaml` as the canonical schedule and validate Longhorn RecurringJobs exist in-cluster after sync.

### 22. Opt all `longhorn-retain` PVCs into backups — IMPLEMENTED
**Plan:** Add `recurring-job-group.longhorn.io/truenas-backup: "enabled"` to remaining critical PVCs and Helm values so critical data is not accidentally unprotected.

### 23. Verify backup target health end-to-end
**Plan:** Confirm Longhorn backup target connectivity, recent backup objects, and restore metadata validity against TrueNAS.

### 24. Keep Longhorn replica guardian CronJob — VERIFIED
**Plan:** Leave `longhorn-replica-guardian` in place, validate successful runs, and watch that it does not flap healthy volumes.

### 25. Keep backup verifier CronJob — VERIFIED
**Plan:** Leave `longhorn-backup-verifier` enabled and ensure alerts fire when backups exceed the 36h freshness window.

### 26. Add per-volume backup freshness dashboard
**Plan:** Display latest backup age, count, and state in Grafana and the console storage view.

### 27. Set non-critical game volumes to 2 replicas
**Plan:** Review game-hub PVC templates and change Longhorn replica count defaults for rebuildable data to reduce cluster memory/disk pressure.

### 28. Keep critical PVCs on `longhorn-retain`
**Plan:** Audit Authentik, OpenBao, NetBird, OneDev, Wazuh, and MinIO to confirm critical data stays on 3-replica storage classes.

### 29. Enable replica soft anti-affinity globally
**Plan:** Confirm Longhorn soft anti-affinity is set so replicas spread without causing hard scheduling failures during node outage scenarios.

### 30. Tune instance-manager resources
**Plan:** Review `instance-manager-limits.yaml`, compare against real rebuild throughput, and size CPU reservations to prevent replica rebuild starvation.

### 31. Add Longhorn rebuild duration alerts
**Plan:** Alert if degraded volumes remain degraded longer than expected after node recovery or replica replacement.

### 32. Add snapshot-before-maintenance automation
**Plan:** Take local snapshots for critical Longhorn volumes automatically before controlled node drains or chart upgrades.

### 33. Add restore validation drills
**Plan:** Restore a sample critical volume to a scratch namespace on a schedule and verify application data integrity.

### 34. Add stale engine/replica cleanup review
**Plan:** Expand automation to identify detached stale resources that consume disk without contributing to durability.

### 35. Add Longhorn disk pressure early-warning alert
**Plan:** Alert on low free space before replica scheduling fails or rebuilds stall.

### 36. Add volume owner metadata standard
**Plan:** Label PVCs by app, tier, and restore priority so restore order is clear during incidents.

### 37. Add backup exclusion policy for rebuildable data
**Plan:** Explicitly document which game or cache volumes are intentionally not backed up to reduce backup churn.

### 38. Add recurring backup restore manifests
**Plan:** Store templated restore manifests for Authentik, OpenBao, and OneDev so restores are repeatable under pressure.

### 39. Add Longhorn API health probe in console
**Plan:** Surface API latency and error rate so storage control-plane degradation is visible before volumes fail.

### 40. Add TrueNAS capacity guardrail
**Plan:** Alert when the backup target approaches a retention cliff so backup jobs do not silently fail from lack of space.

## 3. ArgoCD reliability (ideas 41–55)

### 41. Keep ArgoCD self-healer CronJob — VERIFIED
**Plan:** Preserve the existing every-5-minute healer, verify it remains unsuspended, and watch missed-success alerts.

### 42. Add health checks for every custom resource kind
**Plan:** Review all installed CRDs and add ArgoCD health customizations for kinds that still show `Unknown` or noisy `Progressing` states.

### 43. Add sync retry policy defaults for critical apps
**Plan:** Ensure critical apps have bounded retry backoff so transient startup or dependency timing issues heal automatically.

### 44. Add sync-wave dependency audit
**Plan:** Re-check sync waves among secrets, storage, CRDs, ingress, and apps to reduce false degradation during cluster restarts.

### 45. Add node-pressure sync suppression gate
**Plan:** Pause or skip non-critical sync attempts when the cluster is in MemoryPressure or widespread NotReady state.

### 46. Add ArgoCD app-of-apps degradation summary
**Plan:** Surface a compact top-level summary of degraded children so bootstrap parents do not hide the real failing apps.

### 47. Add out-of-sync age alerting
**Plan:** Alert when critical apps stay OutOfSync longer than expected instead of only when a single sync operation fails.

### 48. Add notifications for sync failures
**Plan:** Confirm Discord/Slack hooks are enabled for failed syncs and degraded apps with deduplication to avoid fatigue.

### 49. Add repo-server resource safety review
**Plan:** Validate repo-server memory requests/limits against actual large-manifest render loads to prevent self-induced sync failures.

### 50. Add app-specific maintenance windows
**Plan:** Let selected apps pause auto-sync during planned storage/network work while leaving core security components reconciling.

### 51. Add post-sync smoke checks for core apps
**Plan:** Run HTTP/TCP or Kubernetes readiness smoke checks after critical syncs and notify if the new revision never becomes healthy.

### 52. Add drift budget reporting
**Plan:** Track how often apps drift and which namespaces create the most self-healing work to target noisy configs first.

### 53. Add custom health for Longhorn CRs
**Plan:** Improve ArgoCD health for backup and volume-related custom resources so storage issues are visible in GitOps status.

### 54. Add fail-open rules for intentionally scaled-to-zero apps
**Plan:** Keep game and community apps from poisoning overall GitOps health when they are intentionally stopped.

### 55. Add ArgoCD disaster-recovery runbook
**Plan:** Document token recovery, admin access, bootstrap re-apply, and minimal app restore order if ArgoCD itself is lost.

## 4. Pod restart / recovery (ideas 56–70)

### 56. Keep critical PDBs present — VERIFIED
**Plan:** Preserve existing budgets for Authentik, ArgoCD, Traefik, and InfraWeaver console and validate they still match replica counts.

### 57. Add PDB visibility in console — IMPLEMENTED
**Plan:** Surface PDB health, selectors, and disruptions allowed on the cluster nodes page so maintenance blast radius is obvious.

### 58. Add PDB coverage audit for critical namespaces
**Plan:** Review monitoring, secrets, storage, DNS, and security namespaces for missing PDBs on critical components.

### 59. Add readiness probe audit for all Deployments
**Plan:** Identify workloads missing readiness probes and add protocol-appropriate checks so traffic only hits healthy pods.

### 60. Add startup probes for slow starters
**Plan:** Focus on large Java, identity, and search workloads to reduce false liveness restarts during cold boot or restore scenarios.

### 61. Standardize termination grace periods
**Plan:** Set sane defaults per class of workload so stateful apps stop cleanly and stateless apps roll fast without hanging drains.

### 62. Add config checksum rollout triggers
**Plan:** Use checksum annotations for ConfigMaps and Secrets so pods restart when config changes instead of remaining stale.

### 63. Add restart-loop early alerting
**Plan:** Alert before CrashLoopBackOff becomes chronic by watching accelerated restart rates and failed startup probe patterns.

### 64. Add preStop hook audit
**Plan:** Check ingress and user-facing apps for connection-drain hooks so restarts do not cut active sessions abruptly.

### 65. Add graceful shutdown tests for Authentik and console
**Plan:** Verify rollouts keep readiness during shutdown and new pods become ready before old ones terminate.

### 66. Add recovery annotations for restart priority
**Plan:** Label workloads by recovery priority so automated remediators know which pods to restart or migrate first.

### 67. Add restart-safe secret rotation policy
**Plan:** Sequence secret updates so dependent apps do not all restart simultaneously during credentials rotation.

### 68. Add pod anti-affinity review for singleton-sensitive apps
**Plan:** Where replicas exist, ensure pods are not co-located and evaluate whether extra replica count is warranted.

### 69. Add stuck terminating pod janitor logic
**Plan:** Expand cleanup automation to detect pods blocked on finalizers or dead nodes and remediate safely.

### 70. Add pod recovery scorecard
**Plan:** Measure mean time from unhealthy to ready per workload class and use it to prioritize probe and startup tuning.

## 5. Storage reliability (ideas 71–80)

### 71. Add backup status to storage page — IMPLEMENTED
**Plan:** Display per-volume backup freshness, counts, and state so operators do not need to open the Longhorn UI for routine checks.

### 72. Add reliability score API endpoint — IMPLEMENTED
**Plan:** Aggregate nodes, ArgoCD, uptime, storage, and backup freshness into a single machine-readable reliability signal.

### 73. Verify Velero schedule success regularly
**Plan:** Check Velero backup schedules, most recent successful runs, and retention objects in the object store or MinIO target.

### 74. Add pre-backup database hooks
**Plan:** Quiesce or snapshot databases before backup windows for more consistent Authentik, Wazuh, and OneDev recovery points.

### 75. Add NFS backup mount accessibility checks
**Plan:** Probe TrueNAS export reachability from the cluster and alert before Longhorn backups silently age out.

### 76. Add backup annotation policy
**Plan:** Enforce that every `longhorn-retain` PVC carries either a backup annotation or an explicit opt-out label.

### 77. Add restore-priority classification
**Plan:** Label stateful apps by RTO/RPO tier so restore order during disaster recovery is predetermined.

### 78. Add PVC growth forecasting
**Plan:** Combine Longhorn usage and backup churn to predict when critical PVCs need expansion before pressure events appear.

### 79. Add cross-check between PVCs and backup objects
**Plan:** Periodically compare live critical PVC inventory with backup volume inventory and alert on mismatches.

### 80. Add backup failure incident template
**Plan:** Document immediate triage steps for stale/missing backups including Longhorn, NFS, and restore verification commands.

## 6. Network reliability (ideas 81–90)

### 81. Verify Traefik backend health checks
**Plan:** Audit services behind Traefik to ensure probes and service endpoints prevent routing to dead or warming pods.

### 82. Add Traefik circuit breaker policies
**Plan:** Use middleware or service policies for unstable backends so spikes or failing pods do not collapse user-facing routes.

### 83. Add DNS synthetic checks
**Plan:** Continuously resolve internal service names and key external dependencies from multiple namespaces.

### 84. Add NetBird relay stability probes
**Plan:** Watch relay/signal connectivity, session counts, and restart rates to catch VPN degradation early.

### 85. Add internal/external ingress latency SLOs
**Plan:** Measure request latency through Traefik for critical routes and alert on sustained degradation.

### 86. Add service endpoint depletion alerts
**Plan:** Alert when Deployments behind key Services drop to zero ready endpoints even before ingress failures surface.

### 87. Add DNS cache poisoning / stale record audit
**Plan:** Validate TTLs and controller updates for external-dns-managed records to reduce drift after rollout or failover.

### 88. Add network policy regression tests
**Plan:** Periodically test expected allowed and denied flows so security hardening does not accidentally break recovery paths.

### 89. Add cluster egress dependency inventory
**Plan:** Document which core apps require external access so outages to cloud APIs or DNS are mapped to platform impact.

### 90. Add ingress failover drill
**Plan:** Rehearse Traefik pod loss, backend loss, and cert-manager renewal edge cases to ensure routes recover cleanly.

## 7. Automated recovery (ideas 91–100)

### 91. Keep Unknown/OutOfSync self-healing in ArgoCD — VERIFIED
**Plan:** Leave the healer in place, monitor its success timestamps, and avoid duplicate automation that fights it.

### 92. Add faster Unknown-pod detection
**Plan:** Extend automation to spot pods stuck in `Unknown` after node loss and clean them up earlier.

### 93. Add automated memory-pressure cordon logic
**Plan:** Cordon nodes that cross a repeated pressure threshold, but only after confirming enough alternate capacity exists.

### 94. Add game-server autoscale-down under pressure
**Plan:** Pause or scale down low-priority game workloads when platform safety margin falls below a configured floor.

### 95. Add automated Longhorn rebalance after node recovery
**Plan:** Re-evaluate replica placement after nodes return so resilience restores automatically instead of staying lopsided.

### 96. Add recovery workflow scoreboard
**Plan:** Track which CronJobs or remediators ran during an incident and whether they improved health within target time.

### 97. Add safeguard to prevent automation storms
**Plan:** Add cooldowns, jitter, and max-actions-per-window so multiple remediators do not overload the cluster at once.

### 98. Add automated node drain preflight checks
**Plan:** Verify PDBs, backup freshness, ready endpoints, and Longhorn health before any automated maintenance drain proceeds.

### 99. Add maintenance-mode awareness across all remediators
**Plan:** Reuse the self-healer maintenance toggle so storage, node, and janitor automations can pause together when needed.

### 100. Add monthly resilience game day
**Plan:** Run controlled drills for node reboot, Longhorn degrade, ArgoCD sync failure, and backup restore so the platform stays practiced.
