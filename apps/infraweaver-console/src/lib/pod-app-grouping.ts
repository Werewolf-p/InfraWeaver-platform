import type { KubernetesPod } from "@/types/kubernetes";

/**
 * Pod → App ownership resolution.
 *
 * The Apps page drills into the pods that make up each app. Every app is
 * delivered to a single destination namespace and the console's durable stop
 * action scales every controller in that namespace to zero, so the namespace is
 * the authoritative grouping unit — and matches exactly what "Stop app"
 * terminates (see lib/app-power.ts `scaleNamespace`).
 *
 * When several apps share one namespace (multiple ArgoCD apps, or every
 * WordPress site living in the shared `wordpress` namespace) we disambiguate
 * with progressively weaker signals, strongest first:
 *
 *   1. Identity labels (`infraweaver.io/site`, the ArgoCD instance label, …).
 *   2. Controller owner references (workload named after the app).
 *   3. The pod's own name (workload prefix) — the fallback for backends that
 *      omit labels/ownerReferences from their pod listings.
 *
 * Prefix-based tiers (2 and 3) prefer the longest matching identifier so that
 * co-located apps with nested names ("blog" vs "blog-shop") resolve to the more
 * specific owner instead of being shared. This keeps grouping correct without
 * re-querying the cluster and degrades gracefully when signals are missing.
 */

export interface AppIdentity {
  /** ArgoCD application name (e.g. "catalog-bar-manifests") or WordPress site id. */
  name: string;
  /** Destination namespace the app deploys into. */
  namespace: string;
}

// Labels ArgoCD/Helm/Kustomize commonly stamp onto an app's workloads, plus the
// WordPress manager's per-site label. The site label and ArgoCD's default app
// tracking label are the strongest signals; the rest are best-effort fallbacks.
const APP_IDENTITY_LABELS = [
  "infraweaver.io/site",
  "app.kubernetes.io/instance",
  "app.kubernetes.io/part-of",
  "app.kubernetes.io/name",
  "app",
] as const;

/** Strip the catalog/community ArgoCD naming wrapper to the bare app slug. */
function shortAppName(name: string): string {
  return name.replace(/^catalog-/, "").replace(/-manifests$/, "");
}

function candidateIdentifiers(app: AppIdentity): Set<string> {
  return new Set([app.name, shortAppName(app.name)].filter(Boolean));
}

/** True when the pod's identity labels point at this specific app. */
export function podMatchesAppByLabel(pod: KubernetesPod, app: AppIdentity): boolean {
  const labels = pod.labels;
  if (!labels) return false;
  const ids = candidateIdentifiers(app);
  return APP_IDENTITY_LABELS.some((key) => {
    const value = labels[key];
    return value !== undefined && ids.has(value);
  });
}

/** Longest app identifier the value equals or is a `<id>-` workload child of. */
function prefixMatchLength(value: string, app: AppIdentity): number {
  let best = 0;
  for (const id of candidateIdentifiers(app)) {
    if (value === id || value.startsWith(`${id}-`)) best = Math.max(best, id.length);
  }
  return best;
}

function ownerMatchLength(pod: KubernetesPod, app: AppIdentity): number {
  const owners = pod.ownerReferences;
  if (!owners || owners.length === 0) return 0;
  return owners.reduce((best, owner) => Math.max(best, prefixMatchLength(owner.name, app)), 0);
}

/** True when a controller owning the pod is named after this app. */
export function podMatchesAppByOwner(pod: KubernetesPod, app: AppIdentity): boolean {
  return ownerMatchLength(pod, app) > 0;
}

/** True when the pod's own name carries the app's workload prefix. */
export function podMatchesAppByName(pod: KubernetesPod, app: AppIdentity): boolean {
  return prefixMatchLength(pod.name, app) > 0;
}

/**
 * Apps whose prefix-style match is the strongest (longest identifier). Returns
 * empty when nothing matches at all.
 */
function bestPrefixTargets(
  candidates: readonly AppIdentity[],
  matchLength: (app: AppIdentity) => number,
): AppIdentity[] {
  const scored = candidates.map((app) => ({ app, score: matchLength(app) }));
  const best = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  if (best === 0) return [];
  return scored.filter((entry) => entry.score === best).map((entry) => entry.app);
}

/**
 * Group pods by their owning app.
 *
 * Precedence per pod:
 *   1. Namespace must match — pods outside an app's destination namespace never
 *      belong to it.
 *   2. With a single app in the namespace, every pod there belongs to it.
 *   3. With multiple apps sharing a namespace, take the strongest signal tier
 *      that produces a match: identity labels, then owner references, then the
 *      pod's own name prefix. If no tier matches the pod is shared across the
 *      ambiguous apps (so it is never silently dropped).
 *
 * Returns a record keyed by `app.name`, each with the owned pods (input order
 * preserved). Pods are never mutated.
 */
export function groupPodsByApp(
  apps: readonly AppIdentity[],
  pods: readonly KubernetesPod[],
): Record<string, KubernetesPod[]> {
  const result: Record<string, KubernetesPod[]> = {};
  for (const app of apps) result[app.name] = [];

  for (const pod of pods) {
    const candidates = apps.filter((app) => app.namespace === pod.namespace);
    if (candidates.length === 0) continue;

    if (candidates.length === 1) {
      result[candidates[0].name].push(pod);
      continue;
    }

    const byLabel = candidates.filter((app) => podMatchesAppByLabel(pod, app));
    const byOwner = byLabel.length > 0 ? [] : bestPrefixTargets(candidates, (app) => ownerMatchLength(pod, app));
    const byName =
      byLabel.length > 0 || byOwner.length > 0
        ? []
        : bestPrefixTargets(candidates, (app) => prefixMatchLength(pod.name, app));

    const targets =
      byLabel.length > 0 ? byLabel : byOwner.length > 0 ? byOwner : byName.length > 0 ? byName : candidates;
    for (const app of targets) result[app.name].push(pod);
  }

  return result;
}

/** Pods belonging to a single app (convenience wrapper over groupPodsByApp). */
export function podsForApp(
  app: AppIdentity,
  pods: readonly KubernetesPod[],
  siblingApps: readonly AppIdentity[] = [],
): KubernetesPod[] {
  const apps = siblingApps.some((sibling) => sibling.name === app.name)
    ? siblingApps
    : [app, ...siblingApps];
  return groupPodsByApp(apps, pods)[app.name] ?? [];
}
