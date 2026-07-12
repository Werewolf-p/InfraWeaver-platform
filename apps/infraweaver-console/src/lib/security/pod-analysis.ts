// ─────────────────────────────────────────────────────────────────────────────
// security/pod-analysis.ts — pod security-context analysis, extracted verbatim
// from the inline loop in /api/security/enhanced/route.ts so its counting
// semantics (per-container privileged/no-limits counts, per-pod root count,
// Running pods only) are preserved exactly.
// ─────────────────────────────────────────────────────────────────────────────
import type { PodSpec } from "./types";

export interface PodSecurityIssue {
  pod: string;
  namespace: string;
  severity: string;
  issues: string[];
}

export interface PodSecurityCounts {
  /** Pods that run as root or UID 0 (pod- or container-level). */
  rootPodCount: number;
  /** Privileged CONTAINERS (counted per container, as the route does). */
  privilegedCount: number;
  /** Pods mounting a hostPath volume. */
  hostPathCount: number;
  /** Containers with no resource limits (counted per container). */
  noLimitsCount: number;
}

/**
 * Analyze Running pods for security-context weaknesses. Returns aggregate
 * counts plus a per-pod issue list; a pod is "Critical" when any issue
 * mentions privileged or root, otherwise "Warning".
 */
export function analyzePodSecurity(pods: PodSpec[]): { counts: PodSecurityCounts; issues: PodSecurityIssue[] } {
  let rootPodCount = 0;
  let privilegedCount = 0;
  let hostPathCount = 0;
  let noLimitsCount = 0;
  const podSecurityIssues: PodSecurityIssue[] = [];

  for (const pod of pods) {
    if (pod.status?.phase !== "Running") continue;
    const ns = pod.metadata?.namespace ?? "";
    const name = pod.metadata?.name ?? "";
    const issues: string[] = [];

    const podSC = pod.spec?.securityContext;
    const hasHostPath = (pod.spec?.volumes ?? []).some((volume) => volume.hostPath);
    if (hasHostPath) { hostPathCount++; issues.push("hostPath volume mount"); }

    let podRunsAsRoot = podSC?.runAsNonRoot === false || podSC?.runAsUser === 0;

    for (const container of pod.spec?.containers ?? []) {
      const sc = container.securityContext;
      if (sc?.privileged) { privilegedCount++; issues.push(`container '${container.name}' is privileged`); }
      if (!container.resources?.limits) { noLimitsCount++; issues.push(`container '${container.name}' has no resource limits`); }
      if (sc?.runAsNonRoot === false || sc?.runAsUser === 0) { podRunsAsRoot = true; }
      if (!sc?.readOnlyRootFilesystem) { issues.push(`container '${container.name}' missing readOnlyRootFilesystem`); }
      if (sc?.allowPrivilegeEscalation !== false) { issues.push(`container '${container.name}' allows privilege escalation`); }
      if (!sc?.seccompProfile && !podSC?.seccompProfile) { issues.push(`container '${container.name}' missing seccompProfile`); }
    }

    if (podRunsAsRoot) { rootPodCount++; issues.push("runs as root or UID 0"); }

    if (issues.length > 0) {
      const severity = issues.some((issue) => issue.includes("privileged") || issue.includes("root"))
        ? "Critical" : "Warning";
      podSecurityIssues.push({ pod: name, namespace: ns, severity, issues });
    }
  }

  return {
    counts: { rootPodCount, privilegedCount, hostPathCount, noLimitsCount },
    issues: podSecurityIssues,
  };
}
