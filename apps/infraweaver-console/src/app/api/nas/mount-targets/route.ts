// GET /api/nas/mount-targets — every workload a NAS folder can be mounted into.
//
// The mount flow patches a workload's manifest in the GitOps repo, so a target
// is only mountable if the console can find and rewrite that manifest. Rather
// than making the operator type a `manifest_path` (and rejecting it after the
// fact), this route enumerates the catalog and returns the exact tuples
// `/api/nas/mount-workload` accepts: namespace, kind, name, containers, path.
//
// Discovery is over `kubernetes/catalog/*/manifests/*.yaml` in git — NOT the
// live cluster. A workload that exists only in the cluster has no manifest to
// patch, so offering it would produce a mount that the next ArgoCD sync reverts.

import { NextResponse } from "next/server";
import { gitListDir, gitReadFile } from "@/lib/git-provider";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

const CATALOG_ROOT = "kubernetes/catalog";
/** Mountable workload kinds: both carry a pod template we can patch. */
const MOUNTABLE_KINDS = new Set(["Deployment", "StatefulSet"]);
/** Generated NAS volumes live here; they are not mount targets. */
const SKIP_DIRS = new Set(["nas-shares", "_template"]);

export interface NasMountTarget {
  /** Catalog app directory, e.g. `jellyfin`. */
  app: string;
  kind: "Deployment" | "StatefulSet";
  name: string;
  namespace: string;
  containers: string[];
  /** Repo-relative path of the manifest holding this workload. */
  manifestPath: string;
}

interface WorkloadDoc {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { template?: { spec?: { containers?: Array<{ name?: string }> } } };
}

function isYaml(path: string): boolean {
  return /\.ya?ml$/i.test(path);
}

async function targetsInFile(app: string, manifestPath: string, yaml: typeof import("js-yaml")): Promise<NasMountTarget[]> {
  const file = await gitReadFile(manifestPath).catch(() => null);
  if (!file) return [];
  let docs: unknown[];
  try {
    docs = yaml.loadAll(file.content) as unknown[];
  } catch {
    // A manifest we cannot parse is a manifest we must not offer to patch.
    return [];
  }
  const targets: NasMountTarget[] = [];
  for (const doc of docs) {
    const workload = doc as WorkloadDoc;
    if (!workload || typeof workload !== "object") continue;
    if (!workload.kind || !MOUNTABLE_KINDS.has(workload.kind)) continue;
    const name = workload.metadata?.name;
    const namespace = workload.metadata?.namespace;
    const containers = (workload.spec?.template?.spec?.containers ?? [])
      .map((container) => container.name)
      .filter((containerName): containerName is string => Boolean(containerName));
    // Without a namespace in the manifest the mount route cannot match the doc
    // back, and without a container there is nothing to mount into.
    if (!name || !namespace || containers.length === 0) continue;
    targets.push({
      app,
      kind: workload.kind as NasMountTarget["kind"],
      name,
      namespace,
      containers,
      manifestPath,
    });
  }
  return targets;
}

export const GET = withAuth(
  { permission: "nas:read", rateLimit: { name: "nas-mount-targets", limit: 20, windowMs: 60_000 } },
  async () => {
    try {
      const yaml = await import("js-yaml");
      const appDirs = (await gitListDir(CATALOG_ROOT))
        .filter((entry) => entry.type === "dir")
        .map((entry) => entry.path.split("/").pop() ?? "")
        .filter((app) => app && !SKIP_DIRS.has(app));

      const perApp = await Promise.all(
        appDirs.map(async (app) => {
          const manifestDir = `${CATALOG_ROOT}/${app}/manifests`;
          const files = await gitListDir(manifestDir).catch(() => []);
          const yamlFiles = files.filter((entry) => entry.type === "file" && isYaml(entry.path));
          const found = await Promise.all(yamlFiles.map((entry) => targetsInFile(app, entry.path, yaml)));
          return found.flat();
        }),
      );

      const targets = perApp.flat().sort((left, right) =>
        `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`));
      return NextResponse.json({ targets });
    } catch (error) {
      return NextResponse.json({ error: safeError(error), targets: [] }, { status: 500 });
    }
  },
);
