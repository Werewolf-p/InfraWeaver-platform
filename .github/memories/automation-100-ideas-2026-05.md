# Automation 100 Ideas — 2026-05

Repository: `InfraWeaver-platform`  
Branch: `feat/automation`  
Scope reviewed: `.github/workflows/`, `kubernetes/`, `apps/infraweaver-console/src/app/api/`, `apps/infraweaver-console/src/app/(dashboard)/`, `.github/memories/`.

This memory captures **exactly 100 automation ideas** tailored to the current homelab platform plus a concrete implementation plan for each one. Items marked **Implemented** are included in this branch.

## CI/CD automation

### 1. PR ArgoCD diff commenter
- Status: **Planned**
- Why here: CI already validates manifests but operators still inspect drift manually.
- Implementation plan: Extend .github/workflows/ci.yml to render focused argocd/kubectl diffs for changed apps and post them back to the PR.
- Safety guard: Only comment on files touched by the PR and cap noisy output to avoid reviewer fatigue.

### 2. Changed-app workflow fan-out
- Status: **Planned**
- Why here: Build jobs run independently, but repo-wide changes still rely on humans to infer which pipelines matter.
- Implementation plan: Add a change-detection job that routes console, API, node, bootstrap, and Terraform changes to the correct reusable workflow paths in .github/workflows/.
- Safety guard: Never skip mandatory security/validation paths when shared files change.

### 3. Console deploy auto-rollback
- Status: **Implemented in `feat/automation`**
- Why here: Console rollouts already smoke-test, so failed smoke checks should revert automatically instead of waiting for a human.
- Implementation plan: Use .github/workflows/build-console.yml to capture the previous tag, push the new manifest, and restore the prior tag when rollout verification fails.
- Safety guard: Rollback only after the manifest mutation landed and always re-run the smoke test against the restored image.

### 4. API deploy auto-rollback
- Status: **Implemented in `feat/automation`**
- Why here: The API has the same deploy-and-smoke sequence as the console and benefits from identical rollback behavior.
- Implementation plan: Mirror the console rollback logic in .github/workflows/build-api.yml so broken API deploys self-revert.
- Safety guard: Require the previous tag to exist before rollback and surface the restored image in the job summary.

### 5. Node agent canary promotion
- Status: **Planned**
- Why here: The node image is global blast radius, so pushing straight to the template is risky.
- Implementation plan: Split .github/workflows/build-node.yml into publish-canary, smoke, and promote phases with a short-lived canary Application or opt-in template consumer.
- Safety guard: Gate promotion on healthy canary telemetry and preserve the previous tag for fast rollback.

### 6. Image digest pin refresher
- Status: **Planned**
- Why here: Manifest tags drift over time and image-updater fixes only some flows.
- Implementation plan: Add a scheduled workflow that resolves published tags to digests and opens a PR when kubernetes/catalog deployments still use mutable tags.
- Safety guard: Skip images already managed by ArgoCD Image Updater to avoid dueling automation.

### 7. Branch hygiene cleanup
- Status: **Implemented in `feat/automation`**
- Why here: Merged feature branches accumulate quickly in a homelab repo and create noise in operational tooling.
- Implementation plan: Use .github/workflows/branch-hygiene.yml to delete merged remote branches older than a safety window.
- Safety guard: Protect main, ontwikkel, and active feature branches; default to dry-run on manual dispatch.

### 8. Dependency update batching
- Status: **Planned**
- Why here: Dependabot exists, but scattered bumps still create too many tiny reviews.
- Implementation plan: Teach a scheduled workflow to consolidate compatible npm and action updates into weekly batched PRs using labels or generated branch prefixes.
- Safety guard: Exclude security updates from batching so critical fixes still ship immediately.

### 9. Workflow SLA reporter
- Status: **Planned**
- Why here: GitHub Actions failures are easy to miss until an operator opens the Actions tab.
- Implementation plan: Create a scheduled reporter that queries recent workflow runs and posts a summary for ci.yml, security.yml, build-*.yml, and maintenance.yml.
- Safety guard: Only alert when failure streaks exceed a threshold to avoid transient-noise spam.

### 10. Artifact retention tuner
- Status: **Planned**
- Why here: Snapshots, drift plans, and build artifacts can pile up unnoticed on a homelab runner.
- Implementation plan: Audit artifact usage from .github/workflows/maintenance.yml and full-redeploy.yml, then auto-adjust retention or purge stale artifacts on a schedule.
- Safety guard: Never delete artifacts younger than the documented recovery window.

## Security and supply chain

### 11. Matrix security scan for all apps
- Status: **Implemented in `feat/automation`**
- Why here: The previous security workflow focused mainly on the console while API and node agent ship real production code too.
- Implementation plan: Expand .github/workflows/security.yml into a matrix over apps/infraweaver-console, apps/infraweaver-api, and apps/infraweaver-node.
- Safety guard: Use Node 22 consistently so security automation is deterministic across apps.

### 12. SBOM publishing per app
- Status: **Planned**
- Why here: Console-only SBOMs leave blind spots for API and node containers.
- Implementation plan: Generate CycloneDX or npm list artifacts for each app in .github/workflows/security.yml and attach them per run.
- Safety guard: Fail only on generation errors for apps touched by the change set.

### 13. Dockerfile regression watch
- Status: **Planned**
- Why here: Hadolint output is easy to miss, and manual review often overlooks new root-user or latest-tag regressions.
- Implementation plan: Persist a baseline of Dockerfile findings and alert only on new high-severity deltas across apps/*.Dockerfile.
- Safety guard: Ignore accepted legacy findings until the Dockerfiles are explicitly remediated.

### 14. Workflow action digest watcher
- Status: **Planned**
- Why here: Pinned SHAs still age out and may miss security advisories.
- Implementation plan: Add a scheduled GitHub Action that compares workflow SHAs in .github/workflows/ against the latest trusted releases and raises a PR.
- Safety guard: Require human review for major-version action jumps.

### 15. Secret pattern allowlist enforcement
- Status: **Planned**
- Why here: Manual grep checks can still false-positive or miss environment-specific patterns.
- Implementation plan: Create a repo-maintained allowlist for known-safe test tokens and enforce it in security.yml secret-scan steps.
- Safety guard: Reject new inline secrets unless they match an approved fixture or mock path.

### 16. Runner disk pressure self-clean
- Status: **Planned**
- Why here: Self-hosted runners frequently fail from disk pressure before builds even begin.
- Implementation plan: Add a preflight job that checks docker, npm cache, and runner temp usage, then prunes only safe caches before build/security jobs.
- Safety guard: Abort cleanup if any protected path exceeds a deletion allowlist.

### 17. CodeQL-lite TypeScript scan
- Status: **Planned**
- Why here: The repo already runs dependency and secret checks but lacks code-flow security analysis.
- Implementation plan: Introduce a lightweight CodeQL or semgrep-style TypeScript scan focused on apps/infraweaver-console and apps/infraweaver-api.
- Safety guard: Run on PRs and keep it advisory until baseline noise is understood.

### 18. OCI signature verification
- Status: **Planned**
- Why here: Images are built internally but nothing currently verifies signatures before rollout.
- Implementation plan: Add cosign verification gates in build-console.yml/build-api.yml before pushing deployment manifest updates.
- Safety guard: Allow emergency bypass only via explicit workflow_dispatch input and audit it in the job summary.

### 19. Workflow permission minimizer
- Status: **Planned**
- Why here: Several workflows still request broader permissions than the exact automation needs.
- Implementation plan: Audit every file in .github/workflows/ and auto-fail PRs that widen permissions without a matching justification comment.
- Safety guard: Permit broader scopes only in destructive recovery workflows like full-redeploy.yml.

### 20. OpenBao secret lease freshness checker
- Status: **Planned**
- Why here: Static secrets age silently even when ExternalSecrets stays Ready.
- Implementation plan: Schedule an automation that inspects secret timestamps and OpenBao lease metadata for critical secrets such as repo creds and registry auth.
- Safety guard: Report first; rotate automatically only for secrets with documented reissue playbooks.

## GitOps and ArgoCD resilience

### 21. ArgoCD sync failure escalator
- Status: **Planned**
- Why here: Self-healer already refreshes drift, but hard failures still require humans to inspect controller logs.
- Implementation plan: Add a companion CronJob in kubernetes/core/argocd/manifests/ that annotates repeatedly failed apps, captures failure context, and pings Discord.
- Safety guard: Skip known structural degradations listed in the existing self-healer memory and ConfigMap state.

### 22. ArgoCD rollback recommendation bot
- Status: **Planned**
- Why here: Operators often know a rollout is bad but still need to hunt the prior good tag manually.
- Implementation plan: Record the previous image tag in build workflows and publish it as an Application annotation that rollback.yml and the console can read.
- Safety guard: Only recommend tags that also passed smoke tests.

### 23. Bootstrap app health convergence
- Status: **Planned**
- Why here: The app-of-apps layer inherits child failures and causes confusing degraded storms.
- Implementation plan: Teach self-healer or a new bootstrap watcher to distinguish inherited child failures from bootstrap-level drift and suppress redundant alerts.
- Safety guard: Never suppress child alerts themselves—only the inherited umbrella signal.

### 24. ArgoCD notification dedupe
- Status: **Planned**
- Why here: Rapid self-heal loops can still emit duplicate Discord noise during cluster churn.
- Implementation plan: Persist last-sent hashes for core-argocd notifications and skip duplicate alert payloads inside the existing self-healer ConfigMap state.
- Safety guard: Expire dedupe entries after a clear cooldown so real regressions still page.

### 25. ApplicationSet orphan detector
- Status: **Planned**
- Why here: ApplicationSet generators can silently stop covering files after repo refactors.
- Implementation plan: Add CI logic that compares expected kubernetes/* application.yaml paths with generated ApplicationSet outputs in kubernetes/bootstrap/.
- Safety guard: Fail only when an app disappears unexpectedly, not when groups are intentionally disabled.

### 26. Repo credential drift fixer
- Status: **Planned**
- Why here: ArgoCD repo secrets can go stale after token rotation even when GitHub Actions keeps building happily.
- Implementation plan: Extend maintenance.yml with a read-only repo credential health probe and optional refresh task using the existing refresh-argocd-token path.
- Safety guard: Require a dispatch input for actual secret mutation.

### 27. Diff cache refresher for stuck apps
- Status: **Planned**
- Why here: Some apps sit in Synced+Degraded because the cache never refreshed at the right time.
- Implementation plan: Add a targeted hard-refresh job for apps matching persistent health-message patterns without forcing sync on every cycle.
- Safety guard: Keep the existing transient and exclusion lists as the first safety boundary.

### 28. Application health SLO export
- Status: **Planned**
- Why here: Health is visible in ArgoCD UI but not summarized as an operational objective.
- Implementation plan: Generate a daily SLO digest from argocd applications, self-healer activity, and repeated sync retries, then surface it in the console and Discord.
- Safety guard: Only count apps that are enabled in platform.yaml to avoid catalog noise.

### 29. Auto-create maintenance windows
- Status: **Planned**
- Why here: Major planned changes still rely on humans to toggle maintenance mode in time.
- Implementation plan: Use workflow_dispatch inputs or commit labels to set and clear the self-healer maintenance ConfigMap automatically around risky operations.
- Safety guard: Always add an absolute expiry so maintenance mode cannot stick forever.

### 30. Manifest provenance annotations
- Status: **Planned**
- Why here: When a live object drifts it can be hard to tell which workflow or PR last touched it.
- Implementation plan: Have build and apply workflows stamp manifests with source commit, workflow run URL, and deploy timestamp annotations before ArgoCD syncs them.
- Safety guard: Restrict annotations to operator-visible metadata and never embed secrets or tokens.

## Storage, backups, and recovery

### 31. Longhorn replica guardian
- Status: **Implemented in `feat/automation`**
- Why here: Degraded Longhorn volumes are one of the most painful manual interventions in this homelab.
- Implementation plan: Add kubernetes/core/longhorn/manifests/automation-jobs.yaml to reconcile degraded volumes back toward desired replica count and best-effort balance.
- Safety guard: Touch only volumes currently marked degraded or faulted and leave healthy volumes alone.

### 32. Longhorn backup verifier
- Status: **Implemented in `feat/automation`**
- Why here: Nightly Longhorn backups are configured but freshness still needed manual inspection.
- Implementation plan: Use the Longhorn API from kubernetes/core/longhorn/manifests/automation-jobs.yaml to fail when backup volumes have no recent backups.
- Safety guard: Alert only when the freshness window is genuinely exceeded, not during the backup itself.

### 33. Longhorn orphaned replica sweeper
- Status: **Planned**
- Why here: The memories mention orphan cleanup patterns, but operators still have to notice scheduling inflation first.
- Implementation plan: Create a scheduled Longhorn API or CRD sweeper that reports orphaned replicas and auto-deletes ones older than a conservative threshold.
- Safety guard: Require the replica to be detached and volume state to be healthy before deletion.

### 34. Longhorn backup restore drill
- Status: **Planned**
- Why here: Backups are only trustworthy when restores are rehearsed.
- Implementation plan: Introduce a weekly job that restores one small canary PVC from the latest Longhorn backup into a scratch namespace and verifies filesystem contents.
- Safety guard: Use a disposable namespace and delete the restore target after the check completes.

### 35. Longhorn disk pressure rebalance
- Status: **Planned**
- Why here: StorageScheduled inflation and uneven replica placement still need human balancing decisions.
- Implementation plan: Poll Longhorn node stats and automatically raise replicaAutoBalance on nodes that cross a storage-pressure watermark.
- Safety guard: Never increase replica counts on nodes already below the reserved-capacity threshold.

### 36. Velero backup freshness verify
- Status: **Planned**
- Why here: Velero schedules exist but success age still required kubectl inspection.
- Implementation plan: Add a maintenance.yml task that inspects backups.velero.io completion timestamps for daily-all and weekly-full schedules.
- Safety guard: Fail only when completed backups are stale beyond generous windows.

### 37. Velero namespace restore rehearsal
- Status: **Planned**
- Why here: Weekly backups do not prove that restore RBAC and storage paths still work.
- Implementation plan: Restore a tiny synthetic namespace from the latest daily-all Velero backup on a schedule and assert required objects come back Ready.
- Safety guard: Exclude stateful production namespaces from automated restore tests.

### 38. etcd snapshot checksum validation
- Status: **Planned**
- Why here: Uploading an artifact is not the same as proving the snapshot is intact.
- Implementation plan: Hash etcd snapshots inside maintenance.yml, store the checksum beside the artifact, and verify it before declaring the snapshot healthy.
- Safety guard: Abort if the snapshot file is implausibly small or the checksum step fails.

### 39. OpenBao snapshot restore smoke test
- Status: **Planned**
- Why here: OpenBao raft snapshots exist, but nobody knows they are restorable until disaster strikes.
- Implementation plan: Spin up a disposable bao dev pod or scratch namespace, attempt metadata inspection on the latest snapshot artifact, and report success/failure.
- Safety guard: Never run a restore test against the live OpenBao StatefulSet.

### 40. Backup target capacity forecaster
- Status: **Planned**
- Why here: Backup jobs fail late when MinIO or NFS fills up.
- Implementation plan: Forecast retention consumption from Velero and Longhorn backup volumes and alert before the target storage crosses a saturation threshold.
- Safety guard: Report projected fill date and top consumers rather than deleting backups automatically by surprise.

## Node and workload self-healing

### 41. Node NotReady remediator
- Status: **Implemented in `feat/automation`**
- Why here: Manual cordon and drain during node failure is repetitive and slow.
- Implementation plan: Add kubernetes/core/argocd/manifests/node-automation.yaml to cordon and drain worker nodes that remain NotReady past a timeout.
- Safety guard: Skip control-plane nodes and require at least one other Ready node before eviction.

### 42. Node memory rebalancer
- Status: **Implemented in `feat/automation`**
- Why here: The cluster page already knows how to migrate pods, but hotspots still need a click.
- Implementation plan: Use node metrics plus opt-in pod annotations in kubernetes/core/argocd/manifests/node-automation.yaml to shift memory-heavy pods off >90% nodes.
- Safety guard: Only rebalance annotated workloads and keep a cool-node threshold so moves are meaningful.

### 43. Workload janitor
- Status: **Implemented in `feat/automation`**
- Why here: Failed Jobs and Evicted pods linger, degrade Argo health, and confuse operators.
- Implementation plan: Add kubernetes/core/argocd/manifests/workload-janitor.yaml to clean completed/failed Jobs and stale Evicted pods on an hourly cadence.
- Safety guard: Honor generous TTLs so recent failures remain inspectable.

### 44. OOMKilled resource recommender
- Status: **Planned**
- Why here: The self-heal workflow restarts OOMKilled pods but does not close the loop on why they died.
- Implementation plan: Collect repeated OOMKilled events, map them back to deployments, and open a config recommendation or auto-PR against values.yaml/resource blocks.
- Safety guard: Never auto-raise limits without also checking node allocatable headroom.

### 45. Pending pod scheduler helper
- Status: **Planned**
- Why here: Pending pods often need the same diagnosis steps every time: quota, node pressure, affinity, or PVC attachment.
- Implementation plan: Add a scheduled analyzer that groups Pending reasons and posts the likely fix path to the console and Discord.
- Safety guard: Do not delete Pending pods unless the reason is explicitly safe to retry.

### 46. VolumeAttachment cleaner
- Status: **Planned**
- Why here: Stale CSI attachments already appear in maintenance self-heal, but the logic can be separated and monitored on its own cadence.
- Implementation plan: Split stale VolumeAttachment cleanup into a dedicated automation with clearer summaries and retry boundaries.
- Safety guard: Only delete attachments reporting attached=false or otherwise verified stale.

### 47. Game server idle scaler
- Status: **Planned**
- Why here: Game hub servers burn resources when nobody is online.
- Implementation plan: Poll player counts from the existing game-hub API routes and scale game workloads to zero or one replica based on quiet windows.
- Safety guard: Protect servers flagged as always-on or in maintenance mode.

### 48. DaemonSet drift detector
- Status: **Planned**
- Why here: Node agents and system DaemonSets silently miss nodes after restarts or taint changes.
- Implementation plan: Add a scheduled controller that compares desiredNumberScheduled vs numberReady for critical DaemonSets and annotates or alerts on drift.
- Safety guard: Ignore nodes intentionally cordoned for maintenance windows.

### 49. Pod restart storm suppressor
- Status: **Planned**
- Why here: Crash loops can trigger endless delete/recreate cycles without surfacing the root problem.
- Implementation plan: Track restart-rate history per pod and pause aggressive self-heal for workloads that exceed a retry budget, escalating to humans instead.
- Safety guard: Use workload annotations to opt out of suppression for truly disposable jobs.

### 50. Node reboot post-check
- Status: **Planned**
- Why here: After a node comes back, humans still verify that replicas, DNS, and networking redistributed correctly.
- Implementation plan: Create a post-Ready checklist automation that validates Longhorn replica health, DaemonSets, MetalLB, and critical deployments after node recovery.
- Safety guard: Only run once per node transition back to Ready to avoid noisy repetition.

## Networking, certificates, and external reachability

### 51. Certificate expiry verifier
- Status: **Planned**
- Why here: Prometheus alerts exist, but a scheduled audit gives operators a digest before certificates cross the critical line.
- Implementation plan: Add cert-expiry-check to .github/workflows/maintenance.yml and reuse the console certificate inventory logic for daily summaries.
- Safety guard: Page on critical windows and summarize warnings without failing unrelated workflows.

### 52. Secret-backed cert expiry scanner
- Status: **Planned**
- Why here: Not every TLS asset is represented as a cert-manager Certificate object.
- Implementation plan: Extend the certificate checker to inspect tls.crt secrets for bare secrets in traefik, argocd, and catalog namespaces.
- Safety guard: Exclude self-signed or explicitly ephemeral secrets from paging.

### 53. Traefik route smoke matrix
- Status: **Planned**
- Why here: Ingress rules drift quietly until users notice 404s or middleware regressions.
- Implementation plan: Create a schedule that curls known internal and external hosts from kubernetes/platform/external-routes/manifests and records pass/fail history.
- Safety guard: Bypass auth-only routes with health endpoints or skip them when no synthetic path exists.

### 54. DNS stale record detector
- Status: **Planned**
- Why here: External-dns and manual DNS entries can diverge from live services.
- Implementation plan: Cross-check Cloudflare/CoreDNS records against ingress and service inventories exposed by the console APIs.
- Safety guard: Alert first and only delete records after an extended stale window with no owning resource.

### 55. NetBird peer drift auditor
- Status: **Planned**
- Why here: NetBird bootstrap and cleanup exist, but peer sprawl still grows between redeploys.
- Implementation plan: Schedule a NetBird API audit that flags peers with no matching cluster/service owner and prepares cleanup commands.
- Safety guard: Never remove peers that were seen recently or belong to non-cluster infrastructure.

### 56. Public endpoint certificate chain check
- Status: **Planned**
- Why here: A certificate can be unexpired and still fail clients because of chain or SAN issues.
- Implementation plan: Run openssl-based chain validation against the main public/internal domains and report mismatched SANs or issuer chains.
- Safety guard: Treat staging Let’s Encrypt certificates differently so rate-limit workarounds do not trigger false alarms.

### 57. MetalLB VIP health confirmer
- Status: **Planned**
- Why here: After etcd or node issues, VIPs often need explicit confirmation beyond controller health.
- Implementation plan: Schedule a small probe set that validates advertised VIPs from monitoring, argocd, and selected ingress services.
- Safety guard: Fail only after multiple consecutive probe windows to avoid flaky network noise.

### 58. External-dns token expiry audit
- Status: **Planned**
- Why here: Cloudflare tokens fail at the worst possible time unless checked early.
- Implementation plan: Use external-dns secrets and provider API metadata to warn before DNS automation credentials expire.
- Safety guard: Keep token inspection read-only and never echo secret values in logs.

### 59. Homepage widget reachability sweep
- Status: **Planned**
- Why here: The homepage/dashboard accumulates links that silently die.
- Implementation plan: Leverage the existing homepage-health/homepage-ping routes to schedule a link and health sweep, then PR broken widget annotations.
- Safety guard: Never auto-remove widgets; only flag them for operator review.

### 60. Webhook delivery retry queue
- Status: **Planned**
- Why here: Webhook tester exists, but real operational webhooks still need resilience when downstream systems blip.
- Implementation plan: Persist failed deliveries and retry them with exponential backoff for selected internal webhook targets.
- Safety guard: Require idempotency markers on payloads before automatic retries are enabled.

## Policy and governance

### 61. CronJob TTL policy
- Status: **Planned**
- Why here: Infrastructure CronJobs still need manual history tuning to avoid degraded parent apps.
- Implementation plan: Extend kubernetes/core/kyverno/manifests/infrastructure-policies.yaml to audit or enforce sane successful/failed history limits and TTLs.
- Safety guard: Roll out in Audit mode first so existing CronJobs are measured before enforcement.

### 62. Automation annotation policy
- Status: **Planned**
- Why here: Self-healing jobs should be easy to discover and inventory.
- Implementation plan: Add a Kyverno policy that requires infraweaver.io/automation metadata on infrastructure CronJobs and Jobs.
- Safety guard: Audit first so older objects can be backfilled gradually.

### 63. Opt-in rebalance annotation policy
- Status: **Planned**
- Why here: Memory rebalancing must never surprise stateful or latency-sensitive workloads.
- Implementation plan: Create a policy that only permits automatic pod moves when workloads explicitly opt in via infraweaver.io/rebalance-memory=true.
- Safety guard: Exclude namespaces with system components and stateful storage workloads.

### 64. Job cleanup exemption policy
- Status: **Planned**
- Why here: Some forensic jobs should outlive the janitor.
- Implementation plan: Reserve infraweaver.io/janitor=skip as a Kyverno-governed annotation and require a justification annotation when it is set.
- Safety guard: Expire exemptions after a fixed time window unless renewed.

### 65. Latest-tag blocker for platform workloads
- Status: **Planned**
- Why here: Catalog policies audit latest tags, but core/platform automations also deserve guardrails.
- Implementation plan: Expand no-latest-tag coverage to kubernetes/core and kubernetes/platform manifests, with documented exceptions for tools that only ship latest.
- Safety guard: Keep exceptions narrow and review them regularly.

### 66. Maintenance window admission guard
- Status: **Planned**
- Why here: Humans can still push risky changes outside agreed maintenance windows.
- Implementation plan: Add a policy or CI gate that blocks destructive platform operations unless a maintenance annotation or workflow input is present.
- Safety guard: Allow emergency bypass with an audited reason string.

### 67. Secret store reference autofix
- Status: **Planned**
- Why here: The existing ExternalSecret store policy prevents mistakes but could also propose repairs.
- Implementation plan: Pair the validation policy with a mutation or CI autofix that rewrites common wrong store names like openbao-backend to openbao.
- Safety guard: Restrict mutation to known typo patterns only.

### 68. Network policy exception expiry
- Status: **Planned**
- Why here: Temporary allowlist exceptions become permanent surprisingly fast.
- Implementation plan: Introduce annotations with expiry timestamps on broad network-policy exceptions and alert when they age out.
- Safety guard: Never auto-delete exceptions without warning if they still see traffic.

### 69. Policy drift reporter
- Status: **Planned**
- Why here: Kyverno policies can sit in Audit forever unless someone checks progress.
- Implementation plan: Build a weekly report of audit violations by namespace and policy, then rank the loudest offenders.
- Safety guard: Suppress duplicate counts for known legacy namespaces until a remediation project starts.

### 70. RBAC scope anomaly detector
- Status: **Planned**
- Why here: RBAC changes in users.yaml and console routes are easy to miss during busy infra work.
- Implementation plan: Diff effective permissions between commits and alert when a user or role gains broader access than expected.
- Safety guard: Whitelist intended onboarding and offboarding changes by commit message or PR label.

## Console and API automation surfaces

### 71. Automation hub dashboard
- Status: **Implemented in `feat/automation`**
- Why here: Operators need one place to see what is automated, what is broken, and what can be manually triggered.
- Implementation plan: Add apps/infraweaver-console/src/app/(dashboard)/automations/page.tsx plus /api/automation/overview to inventory CronJobs and workflow automations.
- Safety guard: Use read-only data by default and keep manual triggers gated behind cluster:admin.

### 72. Automation coverage score
- Status: **Planned**
- Why here: It is hard to know which manual runbooks are still unautomated.
- Implementation plan: Generate a coverage score from the ideas memory, live CronJobs, workflow inventory, and console action routes.
- Safety guard: Treat the score as directional only and show the underlying missing items.

### 73. One-click automation replay
- Status: **Planned**
- Why here: When an automation fails, operators still retype kubectl commands or open GitHub manually.
- Implementation plan: Extend the Automation Hub to trigger CronJobs and selected workflow_dispatch actions from the console.
- Safety guard: Require explicit RBAC plus audit-log entries for every replay.

### 74. Automation audit trail
- Status: **Planned**
- Why here: Self-healing actions should leave the same paper trail as manual admin actions.
- Implementation plan: Record automation-triggered restarts, drains, rebalances, and rollbacks through apps/infraweaver-console/src/lib/audit-log paths or matching server logging.
- Safety guard: Tag entries as automated with the originating CronJob or workflow run URL.

### 75. Automation recommendation cards
- Status: **Planned**
- Why here: The console already exposes rich cluster data but not suggested remediations.
- Implementation plan: Add recommendation cards that light up when events, metrics, or CronJob failures match a known automation or missing automation from the ideas list.
- Safety guard: Never auto-execute from a recommendation without a separate trigger confirmation.

### 76. Health timeline automation overlay
- Status: **Planned**
- Why here: Operators reviewing incidents need to see when automation intervened.
- Implementation plan: Overlay automation runs and recovery actions onto /api/health/timeline and the related dashboard page.
- Safety guard: Collapse repetitive low-value runs so the timeline stays readable.

### 77. Storage automation panel
- Status: **Planned**
- Why here: Longhorn and Velero health are scattered across pages and workflows.
- Implementation plan: Create a dedicated storage automation section linking backup freshness, restore drills, replica guardian runs, and PVC cleanup actions.
- Safety guard: Surface raw timestamps and last failure reason before offering any trigger button.

### 78. Game hub automation controls
- Status: **Planned**
- Why here: Game server lifecycle automation belongs next to the game hub, not only in repo YAML.
- Implementation plan: Expose schedules, backup windows, idle policies, and maintenance automation state through the existing game-hub API routes and detail page.
- Safety guard: Keep per-server overrides explicit and reversible.

### 79. Workflow run summaries in console
- Status: **Planned**
- Why here: GitHub workflow health still forces a context switch out of InfraWeaver.
- Implementation plan: Pull recent workflow results for maintenance, security, and build jobs into the console’s pipelines or automation views.
- Safety guard: Cache results briefly and fail gracefully if the GitHub API token is absent.

### 80. Policy action explorer
- Status: **Planned**
- Why here: Kyverno policy violations are visible in tooling but not tied back to the automations they protect.
- Implementation plan: Add a console explorer that links violated policies, affected workloads, and the automation or runbook that should resolve them.
- Safety guard: Keep it diagnostic-first to avoid confusing policy state with a direct fix path.

## Observability and analytics

### 81. Automation heartbeat dashboard
- Status: **Planned**
- Why here: Self-healing is hard to trust when there is no visual heartbeat for each controller.
- Implementation plan: Publish last-success, last-failure, and trigger counts for every automation into the monitoring stack and surface them in Grafana or the console.
- Safety guard: Store only metadata, not sensitive payloads or secret-derived values.

### 82. Mean-time-to-recovery tracker
- Status: **Planned**
- Why here: The platform fixes many incidents automatically but never quantifies the value.
- Implementation plan: Correlate alerts, automation runs, and workload recovery timestamps to estimate MTTR improvements by automation family.
- Safety guard: Mark estimates as best-effort because cause and effect are not always perfectly attributable.

### 83. Self-heal action counters
- Status: **Planned**
- Why here: Restart and resync loops are easy to miss until they become chronic.
- Implementation plan: Emit Prometheus metrics or structured logs for each automated drain, pod recycle, rebalance, cleanup, and rollback.
- Safety guard: Rate-limit metrics emission so noisy loops do not overload monitoring.

### 84. Automation failure taxonomy
- Status: **Planned**
- Why here: Not all failed automations fail for the same reason, but today they mostly look like generic job failures.
- Implementation plan: Classify failures by credential, API, resource pressure, policy denial, or safety guard and expose those buckets in reports.
- Safety guard: Keep the raw stderr available for operators while using normalized categories for dashboards.

### 85. Canary synthetic transaction suite
- Status: **Planned**
- Why here: Simple health checks miss broken auth flows, session issues, and cross-service regressions.
- Implementation plan: Schedule a small synthetic suite that exercises login, ArgoCD API access, DNS reachability, and one representative app through safe endpoints.
- Safety guard: Use dedicated read-only service accounts and synthetic test identities only.

### 86. Performance baseline snapshots
- Status: **Planned**
- Why here: The repo mentions performance baselines, but build and cluster regressions are not compared automatically.
- Implementation plan: Capture daily baseline metrics for key pages, API latency, ArgoCD sync duration, and Velero backup time, then flag deviations.
- Safety guard: Require several consecutive regressions before paging to avoid transient spikes.

### 87. Alert-to-automation mapping report
- Status: **Planned**
- Why here: Some alerts already have automation coverage and others still require humans, but the distinction is undocumented in the monitoring view.
- Implementation plan: Generate a mapping from Prometheus alerts to automations, console actions, and runbooks using monitoring rules plus the ideas memory.
- Safety guard: Show unmapped alerts prominently so future automation work stays focused.

### 88. Workflow duration anomaly detector
- Status: **Planned**
- Why here: Long-running maintenance and build workflows often signal infrastructure slowness before hard failures appear.
- Implementation plan: Track historical workflow durations and alert when build, maintenance, or security runs exceed normal bands.
- Safety guard: Ignore runs that were manually cancelled or intentionally held for maintenance windows.

### 89. Console API error heatmap
- Status: **Planned**
- Why here: Automation-triggering APIs can degrade long before users notice outright failures.
- Implementation plan: Aggregate status codes and latency for key routes under apps/infraweaver-console/src/app/api/ into a lightweight error heatmap.
- Safety guard: Exclude noisy anonymous endpoints like ping from critical scoring.

### 90. Automation ROI review pack
- Status: **Planned**
- Why here: Ideas accumulate, but periodic review is needed to decide which automations saved the most toil.
- Implementation plan: Generate a monthly pack summarizing triggered automations, prevented incidents, noisy automations, and top remaining manual tasks from this memory.
- Safety guard: Make it read-only and review-oriented so it informs roadmap decisions instead of making them automatically.

## Operations, runbooks, and maintenance

### 91. Maintenance workflow cert checks
- Status: **Implemented in `feat/automation`**
- Why here: Certificates are critical shared infrastructure and deserve the same scheduled automation as backups.
- Implementation plan: Add cert-expiry-check to .github/workflows/maintenance.yml for daily verification with Discord escalation.
- Safety guard: Fail on critical expiries only so the workflow remains actionable.

### 92. Maintenance workflow Velero verification
- Status: **Implemented in `feat/automation`**
- Why here: Backup schedules without freshness verification leave a false sense of safety.
- Implementation plan: Add velero-backup-verify to .github/workflows/maintenance.yml to assert daily and weekly backup recency.
- Safety guard: Use wide freshness windows so a single slow backup does not page the team unnecessarily.

### 93. Talos health probe sweep
- Status: **Planned**
- Why here: Talos outages often start with node-service drift before Kubernetes reports a full outage.
- Implementation plan: Use talosctl in maintenance.yml or ops.yml to capture service readiness, disk pressure, and etcd latency on a regular cadence.
- Safety guard: Keep it read-only unless an explicit recovery task is selected.

### 94. Talos upgrade readiness gate
- Status: **Planned**
- Why here: Upgrades should be blocked automatically when cluster prerequisites are unhealthy.
- Implementation plan: Insert preflight checks into ops.yml talos-upgrade that verify backups, ArgoCD health, and Longhorn replica status first.
- Safety guard: Require all gates green unless a force override is typed into workflow inputs.

### 95. Proxmox resource anomaly watcher
- Status: **Planned**
- Why here: The check-resources task is useful but still manual.
- Implementation plan: Schedule a read-only Proxmox resource audit that compares live VM memory/CPU allocation against host capacity and cluster demand.
- Safety guard: Alert only on sustained overcommit or rapidly shrinking free memory.

### 96. Drift remediation PR creator
- Status: **Planned**
- Why here: Drift detection is valuable, but humans still have to start the reconciliation workflow manually.
- Implementation plan: Teach maintenance.yml drift-detection to optionally open an issue or PR with the plan summary and suggested reconcile command.
- Safety guard: Never auto-apply Terraform from a scheduled event.

### 97. OpenBao seal recovery rehearsals
- Status: **Planned**
- Why here: Unseal resilience exists in memories but needs repeatable validation.
- Implementation plan: Run a scheduled check that verifies unseal key availability, root token secret freshness, and service health without actually resealing OpenBao.
- Safety guard: Do not perform destructive seal operations in automation.

### 98. Runner health watchdog
- Status: **Planned**
- Why here: If the self-hosted runner is down, many automations silently disappear.
- Implementation plan: Add a GitHub-hosted workflow that detects missing self-hosted runner heartbeats and alerts through an external webhook or issue.
- Safety guard: Only page after multiple missed windows so reboots do not spam.

### 99. Memory file freshness reminder
- Status: **Planned**
- Why here: Operational memories lose value if they stop reflecting the codebase.
- Implementation plan: Add a quarterly reminder workflow that checks .github/memories/ topics against recently changed workflows/manifests and asks for refresh PRs.
- Safety guard: Restrict it to issue creation or summary generation, not auto-rewriting memories.

### 100. Runbook-to-automation tracker
- Status: **Planned**
- Why here: The repo now has many memories describing manual fixes that should eventually become code.
- Implementation plan: Maintain a structured map from memory files in .github/memories/ to implemented automations, missing automation ideas, and owning files.
- Safety guard: Close the loop only when code, alerting, and validation exist together—not just when an idea is written down.
