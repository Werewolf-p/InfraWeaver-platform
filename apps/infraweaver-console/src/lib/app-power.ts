import "server-only";
import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { createConfigMapJsonStore } from "@/lib/configmap-store";
import { loadKubeConfig } from "@/lib/k8s";

/**
 * App power + grouping.
 *
 * Lets the console stop/start whole apps — or named groups of apps — as one unit,
 * durably. "Durable" matters here because every app is delivered by ArgoCD with
 * selfHeal plus a cluster self-healer CronJob that re-syncs anything OutOfSync
 * every 5 minutes; a plain scale-to-0 is reverted within minutes.
 *
 * Powering an app OFF therefore does three things together:
 *   1. scales every Deployment/StatefulSet in the app's destination namespace to 0,
 *   2. pauses that ArgoCD Application's automated sync (so ArgoCD won't restore it),
 *   3. annotates the Application `infraweaver.io/power=off` (the self-healer skips
 *      these — see kubernetes/core/argocd/manifests/self-healer.yaml in the infra repo).
 *
 * Powering ON reverses all three: restore the saved sync policy, drop the
 * annotation, and hard-refresh so ArgoCD reconciles replicas back from git.
 *
 * This works for ANY ArgoCD app — private or public — without write access to the
 * app's own source repo. Group definitions are stored in a ConfigMap so they are
 * inspectable with kubectl, mirroring lib/access-store.ts.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.APP_GROUPS_CONFIGMAP_NAME ?? "infraweaver-app-groups";
const ARGOCD_NAMESPACE = "argocd";
const POWER_ANNOTATION = "infraweaver.io/power";
const PREV_SYNC_ANNOTATION = "infraweaver.io/power-prev-sync";

export type PowerState = "on" | "off" | "unknown";
export type PowerAction = "stop" | "start";

export interface AppGroup {
  id: string;
  name: string;
  /** ArgoCD Application names that make up this group. */
  apps: string[];
}

interface ArgoApp {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string>; resourceVersion?: string };
  spec?: { destination?: { namespace?: string }; syncPolicy?: { automated?: unknown } };
}

// ── Group storage (ConfigMap-backed) ─────────────────────────────────────────

const groupStore = createConfigMapJsonStore<{ groups: AppGroup[] }>({
  name: CONFIGMAP_NAME,
  namespace: CONSOLE_NAMESPACE,
  keys: ["groups"],
});

export async function loadGroups(): Promise<AppGroup[]> {
  const stored = await groupStore.load();
  return Array.isArray(stored?.groups) ? stored.groups : [];
}

async function saveGroups(groups: AppGroup[]): Promise<void> {
  await groupStore.save({ groups });
}

export async function createGroup(name: string, apps: string[]): Promise<AppGroup> {
  const groups = await loadGroups();
  const group: AppGroup = { id: randomUUID(), name: name.trim(), apps: [...new Set(apps)] };
  await saveGroups([...groups, group]);
  return group;
}

export async function updateGroup(id: string, patch: Partial<Pick<AppGroup, "name" | "apps">>): Promise<AppGroup | null> {
  const groups = await loadGroups();
  const idx = groups.findIndex((g) => g.id === id);
  if (idx < 0) return null;
  const next: AppGroup = {
    ...groups[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.apps !== undefined ? { apps: [...new Set(patch.apps)] } : {}),
  };
  const copy = [...groups];
  copy[idx] = next;
  await saveGroups(copy);
  return next;
}

export async function deleteGroup(id: string): Promise<boolean> {
  const groups = await loadGroups();
  const next = groups.filter((g) => g.id !== id);
  if (next.length === groups.length) return false;
  await saveGroups(next);
  return true;
}

// ── Power actions ─────────────────────────────────────────────────────────────

function customApi(clusterId?: string) {
  return loadKubeConfig(clusterId).makeApiClient(k8s.CustomObjectsApi);
}
function appsApi(clusterId?: string) {
  return loadKubeConfig(clusterId).makeApiClient(k8s.AppsV1Api);
}

async function getArgoApp(clusterId: string | undefined, name: string): Promise<ArgoApp> {
  return (await customApi(clusterId).getNamespacedCustomObject({
    group: "argoproj.io",
    version: "v1alpha1",
    namespace: ARGOCD_NAMESPACE,
    plural: "applications",
    name,
  })) as ArgoApp;
}

async function replaceArgoApp(clusterId: string | undefined, name: string, body: ArgoApp): Promise<void> {
  await customApi(clusterId).replaceNamespacedCustomObject({
    group: "argoproj.io",
    version: "v1alpha1",
    namespace: ARGOCD_NAMESPACE,
    plural: "applications",
    name,
    body,
  });
}

export function powerStateOf(app: ArgoApp): PowerState {
  const flag = app.metadata?.annotations?.[POWER_ANNOTATION];
  if (flag === "off") return "off";
  return "on";
}

/** Scale every Deployment + StatefulSet in a namespace to `replicas`. */
async function scaleNamespace(clusterId: string | undefined, namespace: string, replicas: number): Promise<string[]> {
  const apps = appsApi(clusterId);
  const [deps, sets] = await Promise.all([
    apps.listNamespacedDeployment({ namespace }),
    apps.listNamespacedStatefulSet({ namespace }),
  ]);
  const depNames = deps.items.map((d) => d.metadata?.name).filter((n): n is string => Boolean(n));
  const setNames = sets.items.map((s) => s.metadata?.name).filter((n): n is string => Boolean(n));
  const [scaledDeps, scaledSets] = await Promise.all([
    Promise.all(depNames.map(async (n) => {
      const scale = await apps.readNamespacedDeploymentScale({ name: n, namespace });
      await apps.replaceNamespacedDeploymentScale({ name: n, namespace, body: { ...scale, spec: { ...(scale.spec ?? {}), replicas } } });
      return `deploy/${n}`;
    })),
    Promise.all(setNames.map(async (n) => {
      const scale = await apps.readNamespacedStatefulSetScale({ name: n, namespace });
      await apps.replaceNamespacedStatefulSetScale({ name: n, namespace, body: { ...scale, spec: { ...(scale.spec ?? {}), replicas } } });
      return `statefulset/${n}`;
    })),
  ]);
  return [...scaledDeps, ...scaledSets];
}

export interface PowerResult {
  app: string;
  action: PowerAction;
  namespace: string;
  workloads: string[];
  state: PowerState;
}

/**
 * Power a single ArgoCD application off (stop) or on (start), durably.
 */
export async function powerApp(clusterId: string | undefined, name: string, action: PowerAction): Promise<PowerResult> {
  const app = await getArgoApp(clusterId, name);
  const namespace = app.spec?.destination?.namespace;
  if (!namespace) throw new Error(`Application ${name} has no destination namespace`);
  const annotations = { ...(app.metadata?.annotations ?? {}) };

  if (action === "stop") {
    // Preserve the current automated sync policy so start can restore it exactly.
    annotations[PREV_SYNC_ANNOTATION] = JSON.stringify(app.spec?.syncPolicy?.automated ?? null);
    annotations[POWER_ANNOTATION] = "off";
    const next: ArgoApp = {
      ...app,
      metadata: { ...app.metadata, annotations },
      spec: { ...app.spec, syncPolicy: { ...(app.spec?.syncPolicy ?? {}), automated: undefined } },
    };
    await replaceArgoApp(clusterId, name, next);
    const workloads = await scaleNamespace(clusterId, namespace, 0);
    return { app: name, action, namespace, workloads, state: "off" };
  }

  // start — restore the saved automated policy, drop the power flag, refresh.
  let restored: unknown = { prune: true, selfHeal: true };
  const prev = annotations[PREV_SYNC_ANNOTATION];
  if (prev) {
    try {
      const parsed = JSON.parse(prev);
      if (parsed) restored = parsed;
    } catch { /* keep default */ }
  }
  delete annotations[POWER_ANNOTATION];
  delete annotations[PREV_SYNC_ANNOTATION];
  annotations["argocd.argoproj.io/refresh"] = "hard";
  const next: ArgoApp = {
    ...app,
    metadata: { ...app.metadata, annotations },
    spec: { ...app.spec, syncPolicy: { ...(app.spec?.syncPolicy ?? {}), automated: restored } },
  };
  await replaceArgoApp(clusterId, name, next);
  return { app: name, action, namespace, workloads: [], state: "on" };
}

/** Power every app in a group; returns a per-app result (errors captured inline). */
export async function powerGroup(
  clusterId: string | undefined,
  apps: string[],
  action: PowerAction,
): Promise<Array<PowerResult | { app: string; action: PowerAction; error: string }>> {
  const out: Array<PowerResult | { app: string; action: PowerAction; error: string }> = [];
  for (const app of apps) {
    try {
      out.push(await powerApp(clusterId, app, action));
    } catch (error) {
      out.push({ app, action, error: error instanceof Error ? error.message : "power action failed" });
    }
  }
  return out;
}
