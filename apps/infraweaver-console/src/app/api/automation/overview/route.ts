import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadCronJobs } from "@/lib/ops-data";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";

const CLUSTER_AUTOMATIONS = [
  {
    id: "node-notready-remediator",
    title: "Node NotReady remediator",
    description: "Cordons and drains worker nodes that stay NotReady past a safety timeout.",
    namespace: "argocd",
    cronjob: "node-notready-remediator",
    file: "kubernetes/core/argocd/manifests/node-automation.yaml",
    category: "Self-healing",
  },
  {
    id: "node-memory-rebalancer",
    title: "Node memory rebalancer",
    description: "Moves opt-in pods away from nodes above 90% memory toward cooler nodes.",
    namespace: "argocd",
    cronjob: "node-memory-rebalancer",
    file: "kubernetes/core/argocd/manifests/node-automation.yaml",
    category: "Capacity",
  },
  {
    id: "workload-janitor",
    title: "Workload janitor",
    description: "Cleans stale failed jobs and old Evicted pods before they poison health signals.",
    namespace: "argocd",
    cronjob: "workload-janitor",
    file: "kubernetes/core/argocd/manifests/workload-janitor.yaml",
    category: "Hygiene",
  },
  {
    id: "longhorn-backup-verifier",
    title: "Longhorn backup verifier",
    description: "Checks that every Longhorn backup volume has a recent backup on the target.",
    namespace: "longhorn-system",
    cronjob: "longhorn-backup-verifier",
    file: "kubernetes/core/longhorn/manifests/automation-jobs.yaml",
    category: "Storage",
  },
  {
    id: "longhorn-replica-guardian",
    title: "Longhorn replica guardian",
    description: "Nudges degraded Longhorn volumes back toward their desired replica state.",
    namespace: "longhorn-system",
    cronjob: "longhorn-replica-guardian",
    file: "kubernetes/core/longhorn/manifests/automation-jobs.yaml",
    category: "Storage",
  },
  {
    id: "argocd-self-healer",
    title: "ArgoCD self-healer",
    description: "Hard-refreshes and re-syncs unhealthy GitOps apps before humans need to intervene.",
    namespace: "argocd",
    cronjob: "argocd-self-healer",
    file: "kubernetes/core/argocd/manifests/self-healer.yaml",
    category: "GitOps",
  },
] as const;

const WORKFLOW_AUTOMATIONS = [
  {
    id: "maintenance",
    title: "Maintenance workflow",
    schedule: "Daily + weekly scheduled checks and manual runbook tasks",
    file: ".github/workflows/maintenance.yml",
    description: "Runs drift checks, snapshots, self-healing, cert checks, and backup verification from GitHub Actions.",
  },
  {
    id: "branch-hygiene",
    title: "Branch hygiene",
    schedule: "Weekly on Sunday 07:30 UTC",
    file: ".github/workflows/branch-hygiene.yml",
    description: "Deletes merged branches that have aged past the configured safety window.",
  },
  {
    id: "security",
    title: "Security scan",
    schedule: "On pull requests and pushes touching app or workflow code",
    file: ".github/workflows/security.yml",
    description: "Audits dependencies, Dockerfiles, secrets, TypeScript health, and SBOMs for all InfraWeaver apps.",
  },
  {
    id: "build-api",
    title: "API deploy auto-rollback",
    schedule: "On main pushes affecting apps/infraweaver-api",
    file: ".github/workflows/build-api.yml",
    description: "Builds, deploys, smoke-tests, and automatically restores the prior API image when health checks fail.",
  },
] as const;

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["infra:read", "cluster:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const canTrigger = hasSessionPermission(access, "cluster:admin");
  const cronPayload = await loadCronJobs();
  const cronjobs = cronPayload.cronjobs ?? [];

  const clusterAutomations = CLUSTER_AUTOMATIONS.map((automation) => {
    const live = cronjobs.find((cronjob) => cronjob.namespace === automation.namespace && cronjob.name === automation.cronjob);
    return {
      ...automation,
      canTrigger,
      live: Boolean(live),
      schedule: live?.schedule ?? null,
      suspended: live?.suspended ?? false,
      activeRuns: live?.active ?? 0,
      lastSuccess: live?.lastSuccess ?? null,
      lastFailure: live?.lastFailure ?? null,
      nextRun: live?.nextRun ?? null,
      failing: live?.failing ?? false,
      recentRuns: live?.recentJobs ?? [],
    };
  });

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      liveCronData: cronPayload.live,
      canTrigger,
      clusterAutomations,
      workflowAutomations: WORKFLOW_AUTOMATIONS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
