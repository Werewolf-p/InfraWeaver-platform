// POST /api/nas/mount-workload — app-centric NAS mount flow.
//
// Plan reference: plans/advanced-storage.md §7 Phase 6.
// Where `/api/nas/assign` is user-centric (records the assignment under
// `users.yaml` for a person), this endpoint is app-centric: the operator picks
// a NAS provider/share/subfolder, an access mode, a target namespace + app
// (Deployment) + mount path, and the console:
//   1. Emits a StorageClass + PVC into `kubernetes/catalog/nas-shares/…` via
//      the shared `generateK8sManifest` (so §3 security invariants apply).
//   2. Patches the target `Deployment` YAML in the same GitOps repo to append
//      `volumes[]` and `containers[0].volumeMounts[]`, with
//      `readOnly: true` when access=readonly (Layer C).
//   3. Commits both files in a single commit — ArgoCD picks up the change and
//      the pod re-rolls with the NAS mount live.
//
// This deliberately does NOT hit the k8s API directly; every change is
// GitOps-committed so the state is auditable and reversible.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gitCommitFiles, gitReadFile } from "@/lib/git-provider";
import { parseAllowedInternalUrl } from "@/lib/internal-url-allowlist";
import { evaluateFolderAcl } from "@/lib/nas/folder-acl";
import { generateK8sManifest, type NasBackend } from "@/lib/nas/manifest";
import { getResolvedNasProvider, resolveNasProviders } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionEffectivePermissions, getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const K8S_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$/;
const SAFE_SUBFOLDER = /^(?!.*\.\.)(?!\/)(?!.*\/\/)[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/i;
const SAFE_MOUNT_PATH = /^\/[a-zA-Z0-9_\-./]{0,254}$/;
const SAFE_HOST = /^[a-z0-9.-]+$/i;

const Body = z.object({
  // Open string — validated against the live provider registry below.
  provider: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  backend: z.enum(["smb", "nfs"]).optional(),
  share: z.string().min(1).max(63).regex(SAFE_NAME),
  subfolder: z.string().min(1).max(200).regex(SAFE_SUBFOLDER).optional(),
  access: z.enum(["readonly", "readwrite"]),
  namespace: z.string().min(1).max(63).regex(K8S_NAME_RE),
  deployment: z.string().min(1).max(253).regex(K8S_NAME_RE),
  container: z.string().min(1).max(63).regex(K8S_NAME_RE).optional(),
  mount_path: z.string().min(1).max(255).regex(SAFE_MOUNT_PATH),
  manifest_path: z.string().min(1).max(255),
  volume_name: z.string().min(1).max(63).regex(K8S_NAME_RE).optional(),
  size: z.string().min(1).max(20).regex(/^[0-9]+(Ki|Mi|Gi|Ti|Pi)$/).optional(),
});

// Sane whitelist: only allow patching files under `kubernetes/catalog/**` so a
// bad request cannot rewrite core platform manifests.
function isAllowedManifestPath(p: string): boolean {
  return /^kubernetes\/catalog\/[a-z0-9][a-z0-9\-_/]*\.ya?ml$/i.test(p) && !p.includes("..");
}

interface DeploymentDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    template?: {
      spec?: {
        volumes?: Array<Record<string, unknown> & { name?: string; persistentVolumeClaim?: { claimName?: string } }>;
        containers?: Array<{ name?: string; volumeMounts?: Array<{ name?: string; mountPath?: string; readOnly?: boolean }> }>;
      };
    };
  };
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rbac = await getSessionRBACContext(session, 60);
  // `nas:write` governs the NAS/share side; patching a Deployment manifest in a
  // cluster namespace is a catalog mutation, so also require `catalog:write`.
  // Without this, a bare `nas:write` holder (e.g. a delegated NAS-only custom
  // group) could inject a volume/volumeMount into ANY catalog Deployment in ANY
  // namespace — cross-tenant privilege escalation.
  if (!hasSessionPermission(rbac, "nas:write") || !hasSessionPermission(rbac, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("nas-mount-workload", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const body = parsed.data;

    if (!isAllowedManifestPath(body.manifest_path)) {
      return NextResponse.json({ error: "manifest_path must be under kubernetes/catalog/" }, { status: 400 });
    }

    const providerCfg = await getResolvedNasProvider(body.provider);
    if (!providerCfg) {
      const registered = (await resolveNasProviders()).map((p) => p.id).join(", ") || "(none)";
      return NextResponse.json({ error: `Unknown NAS provider '${body.provider}'. Registered: ${registered}` }, { status: 400 });
    }
    const backend: NasBackend = body.backend ?? providerCfg.backends[0];
    if (!providerCfg.backends.includes(backend)) {
      return NextResponse.json({ error: `Provider '${body.provider}' does not support backend '${backend}'` }, { status: 400 });
    }
    const host = providerCfg.host;
    if (!SAFE_HOST.test(host) || !parseAllowedInternalUrl(`https://${host}`)) {
      return NextResponse.json({ error: "Invalid NAS host" }, { status: 400 });
    }

    const subfolder = body.subfolder ?? "";

    // Folder-level ACL — same check as `/api/nas/assign`, so a user can't do
    // via the app-centric flow what they aren't allowed to do via the
    // user-centric flow.
    const permissions = [...getSessionEffectivePermissions(rbac)];
    const aclDecision = evaluateFolderAcl({
      username: rbac.username || "unknown",
      groups: rbac.groups,
      permissions,
      provider: body.provider,
      share: body.share,
      subfolder,
      access: body.access,
    });
    if (!aclDecision.allowed) {
      return NextResponse.json({ error: `NAS folder ACL denied: ${aclDecision.reason}` }, { status: 403 });
    }

    const accessSuffix = body.access === "readonly" ? "ro" : "rw";
    const pvc_name = `nas-${body.deployment}-${body.share.toLowerCase()}-${accessSuffix}`;
    const volume_name = body.volume_name ?? `nas-${body.share.toLowerCase()}-${accessSuffix}`;

    // Read + parse the target Deployment.
    const existing = await gitReadFile(body.manifest_path);
    if (!existing) return NextResponse.json({ error: `Manifest not found: ${body.manifest_path}` }, { status: 404 });

    const yaml = await import("js-yaml");
    const docs = yaml.loadAll(existing.content) as unknown[];
    const deployment = docs.find((doc): doc is DeploymentDoc =>
      typeof doc === "object" && doc !== null
      && (doc as { kind?: string }).kind === "Deployment"
      && (doc as { metadata?: { name?: string; namespace?: string } }).metadata?.name === body.deployment
      && (doc as { metadata?: { name?: string; namespace?: string } }).metadata?.namespace === body.namespace,
    );
    if (!deployment) {
      return NextResponse.json({ error: `Deployment ${body.namespace}/${body.deployment} not found in manifest` }, { status: 404 });
    }
    const podSpec = deployment.spec?.template?.spec;
    if (!podSpec?.containers?.length) return NextResponse.json({ error: "Deployment has no containers" }, { status: 400 });
    const container = body.container
      ? podSpec.containers.find((c) => c.name === body.container)
      : podSpec.containers[0];
    if (!container) return NextResponse.json({ error: `Container ${body.container} not found` }, { status: 404 });

    // Idempotency: skip if the same PVC/mount already present.
    podSpec.volumes = podSpec.volumes ?? [];
    if (!podSpec.volumes.some((vol) => vol.persistentVolumeClaim?.claimName === pvc_name)) {
      podSpec.volumes.push({ name: volume_name, persistentVolumeClaim: { claimName: pvc_name } });
    }
    container.volumeMounts = container.volumeMounts ?? [];
    const existingMount = container.volumeMounts.find((vm) => vm.name === volume_name);
    if (!existingMount) {
      container.volumeMounts.push({
        name: volume_name,
        mountPath: body.mount_path,
        ...(body.access === "readonly" ? { readOnly: true } : {}),
      });
    } else {
      existingMount.mountPath = body.mount_path;
      existingMount.readOnly = body.access === "readonly";
    }

    const patchedContent = docs.map((doc) => yaml.dump(doc, { lineWidth: -1, indent: 2 })).join("---\n");

    const scPvcContent = generateK8sManifest({
      username: body.deployment,
      provider: body.provider,
      backend,
      share: body.share,
      subfolder,
      pvc_name,
      pvc_namespace: body.namespace,
      host,
      access: body.access,
      size: body.size,
    }, yaml);
    const manifestSubfolder = subfolder.replace(/\//g, "-") || "root";
    const scPvcPath = `kubernetes/catalog/nas-shares/${body.namespace}-${body.deployment}-${body.share.toLowerCase()}-${manifestSubfolder}-${accessSuffix}.yaml`;

    await gitCommitFiles({
      message: `feat(nas): mount ${body.share}/${subfolder || "/"} (${accessSuffix}) into ${body.namespace}/${body.deployment}`,
      addOrUpdateFiles: [
        { path: scPvcPath, content: scPvcContent },
        { path: body.manifest_path, content: patchedContent },
      ],
    });

    return NextResponse.json({ ok: true, pvc_name, volume_name, sc_pvc_path: scPvcPath, patched: body.manifest_path });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
