import type { KubernetesPod } from "@/types/kubernetes";

/**
 * Pod → App ownership resolution.
 *
 * The Apps page drills into the pods that make up each ArgoCD application. Every
 * app is delivered to a single destination namespace and the console's durable
 * stop action scales every controller in that namespace to zero, so the namespace
 * is the authoritative grouping unit — and matches exactly what "Stop app"
 * terminates (see lib/app-power.ts `scaleNamespace`).
 *
 * When several apps share one namespace we disambiguate with the signals
 * Kubernetes/ArgoCD attach to pods: the standard recommended labels and the
 * controller owner reference. This keeps grouping correct without re-querying the
 * cluster, and degrades gracefully when the backend omits labels/ownerReferences.
 */

export interface AppIdentity {
  /** ArgoCD application name (e.g. "core-foo" or "catalog-bar-manifests"). */
  name: string;
  /** Destination namespace the app deploys into. */
  namespace: string;
}

// Labels ArgoCD/Helm/Kustomize commonly stamp onto an app's workloads. The
// instance label is ArgoCD's default app tracking label and is the strongest
// signal; the rest are best-effort fallbacks.
const APP_IDENTITY_LABELS = [
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

/** True when a controller owning the pod is named after this app. */
export function podMatchesAppByOwner(pod: KubernetesPod, app: AppIdentity): boolean {
  const owners = pod.ownerReferences;
  if (!owners || owners.length === 0) return false;
  const ids = [...candidateIdentifiers(app)];
  return owners.some((owner) =>
    ids.some((id) => owner.name === id || owner.name.startsWith(`${id}-`)),
  );
}

/** A pod carries an explicit (label or owner) signal tying it to this app. */
function podHasExplicitMatch(pod: KubernetesPod, app: AppIdentity): boolean {
  return podMatchesAppByLabel(pod, app) || podMatchesAppByOwner(pod, app);
}

/**
 * Group pods by their owning app.
 *
 * Precedence per pod:
 *   1. Namespace must match — pods outside an app's destination namespace never
 *      belong to it.
 *   2. With a single app in the namespace, every pod there belongs to it.
 *   3. With multiple apps sharing a namespace, prefer apps the pod explicitly
 *      matches by label/owner; if none match explicitly the pod is shared across
 *      the ambiguous apps (so it is never silently dropped).
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

    const explicit = candidates.filter((app) => podHasExplicitMatch(pod, app));
    const targets = explicit.length > 0 ? explicit : candidates;
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
