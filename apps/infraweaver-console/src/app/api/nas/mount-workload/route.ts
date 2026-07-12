// POST /api/nas/mount-workload — mount one NAS folder into N workloads.
// DELETE /api/nas/mount-workload — unmount it from one workload.
//
// Plan reference: plans/advanced-storage.md §7 Phase 6.
//
// This is the app-centric mount flow, and the reason the whole feature is
// generic: the caller names a folder once and a list of targets, and the console
//
//   1. ensures the provider's scoped SMB service accounts exist (RO + RW),
//   2. emits one ExternalSecret per (namespace, access) so each namespace gets
//      only the credential its access mode entitles it to,
//   3. emits a static PV + PVC per (namespace, access) — see `@/lib/nas/manifest`
//      for why static and not a StorageClass,
//   4. patches each target workload's `volumes[]` + `containers[].volumeMounts[]`,
//      with `readOnly: true` wherever access is readonly,
//
// and commits all of it together. ArgoCD rolls the pods; nothing touches the
// Kubernetes API directly, so every mount is auditable and revertible.
//
// The worked example — jellyfin RO and nextcloud RW on the same `media` folder —
// is exactly one POST with two targets.

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { gitCommitFiles, gitReadFile } from "@/lib/git-provider";
import { parseAllowedInternalUrlAsync } from "@/lib/internal-url-allowlist-server";
import { canWriteStorage, nasAccessDecision } from "@/lib/nas/authz";
import { NasAmbiguousPathError, resolveCanonicalSubfolder } from "@/lib/nas/canonical";
import { resolveNasSharePath, type NasFolderTarget } from "@/lib/nas/folders";
import {
  deriveNasManifestPath,
  deriveNasResourceNames,
  deriveNasSecretManifestPath,
  generateNasCredentialExternalSecret,
  generateNasVolumeManifest,
  type NasAccess,
  type NasBackend,
  type NasVolumeIdentity,
} from "@/lib/nas/manifest";
import { ensureProviderSmbCredentials } from "@/lib/nas/mount-credentials";
import { normalizeSubfolder } from "@/lib/nas/paths";
import { resolveNasCredentials } from "@/lib/nas/providers";
import { requireNasProvider } from "@/lib/nas/route-helpers";
import { nasCredsLogicalPath } from "@/lib/nas/store";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SHARE_RE = /^[a-z0-9][a-z0-9\-_]*$/i;
const SAFE_MOUNT_PATH = /^\/[a-zA-Z0-9_\-./]{0,254}$/;
const SAFE_HOST = /^[a-z0-9.-]+$/i;

/** Only `kubernetes/catalog/**` is patchable: a bad request must not rewrite core platform manifests. */
function isAllowedManifestPath(path: string): boolean {
  return /^kubernetes\/catalog\/[a-z0-9][a-z0-9\-_/]*\.ya?ml$/i.test(path) && !path.includes("..");
}

const Target = z.object({
  namespace: z.string().min(1).max(63).regex(K8S_NAME_RE),
  workload: z.string().min(1).max(253).regex(K8S_NAME_RE),
  kind: z.enum(["Deployment", "StatefulSet"]).default("Deployment"),
  container: z.string().min(1).max(63).regex(K8S_NAME_RE).optional(),
  mount_path: z.string().min(1).max(255).regex(SAFE_MOUNT_PATH),
  access: z.enum(["readonly", "readwrite"]),
  manifest_path: z.string().min(1).max(255),
});

const Body = z.object({
  provider: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  backend: z.enum(["smb", "nfs"]).optional(),
  share: z.string().min(1).max(63).regex(SHARE_RE),
  subfolder: z.string().max(200).optional(),
  size: z.string().min(1).max(20).regex(/^[0-9]+(Ki|Mi|Gi|Ti|Pi)$/).optional(),
  targets: z.array(Target).min(1).max(10),
});

const DeleteBody = z.object({
  provider: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  share: z.string().min(1).max(63).regex(SHARE_RE),
  subfolder: z.string().max(200).optional(),
  namespace: z.string().min(1).max(63).regex(K8S_NAME_RE),
  workload: z.string().min(1).max(253).regex(K8S_NAME_RE),
  kind: z.enum(["Deployment", "StatefulSet"]).default("Deployment"),
  access: z.enum(["readonly", "readwrite"]),
  manifest_path: z.string().min(1).max(255),
});

interface WorkloadDoc {
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

function findWorkload(docs: unknown[], kind: string, name: string, namespace: string): WorkloadDoc | undefined {
  return docs.find((doc): doc is WorkloadDoc => {
    const workload = doc as WorkloadDoc;
    return Boolean(workload)
      && typeof workload === "object"
      && workload.kind === kind
      && workload.metadata?.name === name
      && workload.metadata?.namespace === namespace;
  });
}

interface CommitFile { path: string; content: string }

export const POST = withAuth({ logMutating: true }, async ({ req, session }) => {
  const actor = session.user?.email ?? "unauthenticated";
  const rbac = await getSessionRBACContext(session, 60);
  // `nas:write` governs the NAS side and may be held on a `/nas/...` scope alone;
  // the exact folder is checked against its own scope further down. Patching a
  // workload manifest and creating a PVC in a caller-chosen namespace is a
  // catalog mutation, so also require `catalog:write` — at the ROOT scope, since
  // a storage grant says nothing about which Deployments you may edit. Without
  // both, a NAS-only group could inject a volume into ANY catalog Deployment in
  // ANY namespace.
  if (!canWriteStorage(rbac) || !hasSessionPermission(rbac, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("nas-mount-workload", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const body = parsed.data;

    let subfolder: string;
    try {
      subfolder = normalizeSubfolder(body.subfolder);
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 400 });
    }

    for (const target of body.targets) {
      if (!isAllowedManifestPath(target.manifest_path)) {
        return NextResponse.json({ error: `manifest_path must be under kubernetes/catalog/: ${target.manifest_path}` }, { status: 400 });
      }
    }

    const resolvedProvider = await requireNasProvider(body.provider, "listed");
    if (resolvedProvider.response) return resolvedProvider.response;
    const provider = resolvedProvider.provider;
    const backend: NasBackend = body.backend ?? provider.backends[0];
    if (!provider.backends.includes(backend)) {
      return NextResponse.json({ error: `Provider '${body.provider}' does not support backend '${backend}'` }, { status: 400 });
    }
    const host = provider.host;
    if (!SAFE_HOST.test(host) || !(await parseAllowedInternalUrlAsync(`https://${host}`))) {
      return NextResponse.json({ error: "Invalid NAS host" }, { status: 400 });
    }

    // Folder ACL, once per requested access mode — the same gate `/api/nas/assign`
    // applies, so the app-centric path can never grant what the user-centric one
    // would refuse.
    for (const access of new Set(body.targets.map((target) => target.access))) {
      const decision = nasAccessDecision(rbac, { provider: body.provider, share: body.share, subfolder, access });
      if (!decision.allowed) {
        return NextResponse.json({ error: `NAS folder ACL denied: ${decision.reason}` }, { status: 403 });
      }
    }

    const credentials = await resolveNasCredentials(body.provider);
    if (!credentials) return NextResponse.json({ error: `Provider '${body.provider}' has no stored credentials` }, { status: 400 });

    const folderTarget: NasFolderTarget = { kind: provider.kind, host: provider.host, port: provider.port, tlsFingerprint256: provider.tlsFingerprint256 };
    // NFS needs the export's absolute path; SMB does not, but resolving it also
    // proves the share exists before we write any manifest.
    // Fail closed on a case-ambiguous path: `media` and `Media` collapse to one
    // lowercase RBAC scope, so a grant on one would authorize mounting the other.
    // See lib/nas/canonical.ts.
    try {
      await resolveCanonicalSubfolder(folderTarget, credentials, body.share, subfolder);
    } catch (error) {
      if (error instanceof NasAmbiguousPathError) return NextResponse.json({ error: error.message }, { status: 409 });
      throw error;
    }

    const sharePath = await resolveNasSharePath(folderTarget, credentials, body.share);

    // Ensure the scoped mount credentials exist before referencing them from an
    // ExternalSecret that ESO would otherwise fail to resolve forever.
    if (backend === "smb") {
      await ensureProviderSmbCredentials(provider, credentials, { share: body.share });
    }

    const yaml = await import("js-yaml");
    const files = new Map<string, string>();
    const identityFor = (namespace: string, access: NasAccess): NasVolumeIdentity => ({
      provider: body.provider,
      backend,
      host,
      share: body.share,
      sharePath,
      subfolder,
      namespace,
      access,
    });

    // One PV+PVC and one credential ExternalSecret per (namespace, access) —
    // deduplicated, because two workloads in one namespace share the volume.
    for (const target of body.targets) {
      const identity = identityFor(target.namespace, target.access);
      files.set(deriveNasManifestPath(identity), generateNasVolumeManifest({ ...identity, size: body.size }, yaml));
      if (backend === "smb") {
        files.set(
          deriveNasSecretManifestPath(target.namespace, body.provider, target.access),
          generateNasCredentialExternalSecret({
            namespace: target.namespace,
            provider: body.provider,
            access: target.access,
            credsLogicalPath: nasCredsLogicalPath(body.provider, target.access),
            yamlLib: yaml,
          }),
        );
      }
    }

    // Patch each target workload. Several targets may live in one manifest file,
    // so parse-patch-serialise per file, carrying edits forward.
    const parsedManifests = new Map<string, unknown[]>();
    for (const target of body.targets) {
      if (!parsedManifests.has(target.manifest_path)) {
        const existing = await gitReadFile(target.manifest_path);
        if (!existing) return NextResponse.json({ error: `Manifest not found: ${target.manifest_path}` }, { status: 404 });
        parsedManifests.set(target.manifest_path, yaml.loadAll(existing.content) as unknown[]);
      }
      const docs = parsedManifests.get(target.manifest_path) as unknown[];
      const workload = findWorkload(docs, target.kind, target.workload, target.namespace);
      if (!workload) {
        return NextResponse.json({ error: `${target.kind} ${target.namespace}/${target.workload} not found in ${target.manifest_path}` }, { status: 404 });
      }
      const podSpec = workload.spec?.template?.spec;
      if (!podSpec?.containers?.length) return NextResponse.json({ error: `${target.workload} has no containers` }, { status: 400 });
      const container = target.container
        ? podSpec.containers.find((entry) => entry.name === target.container)
        : podSpec.containers[0];
      if (!container) return NextResponse.json({ error: `Container ${target.container} not found in ${target.workload}` }, { status: 404 });

      const names = deriveNasResourceNames(identityFor(target.namespace, target.access));
      const readOnly = target.access === "readonly";

      podSpec.volumes = podSpec.volumes ?? [];
      if (!podSpec.volumes.some((volume) => volume.persistentVolumeClaim?.claimName === names.pvcName)) {
        podSpec.volumes.push({ name: names.volumeName, persistentVolumeClaim: { claimName: names.pvcName } });
      }
      container.volumeMounts = container.volumeMounts ?? [];
      const existingMount = container.volumeMounts.find((mount) => mount.name === names.volumeName);
      if (existingMount) {
        existingMount.mountPath = target.mount_path;
        // Always restate readOnly, so re-mounting readonly over a previous
        // readwrite mount actually downgrades it.
        if (readOnly) existingMount.readOnly = true;
        else delete existingMount.readOnly;
      } else {
        container.volumeMounts.push({
          name: names.volumeName,
          mountPath: target.mount_path,
          ...(readOnly ? { readOnly: true } : {}),
        });
      }
    }

    for (const [path, docs] of parsedManifests) {
      files.set(path, docs.map((doc) => yaml.dump(doc, { lineWidth: -1, indent: 2 })).join("---\n"));
    }

    const addOrUpdateFiles: CommitFile[] = [...files].map(([path, content]) => ({ path, content }));
    const summary = body.targets
      .map((target) => `${target.namespace}/${target.workload} (${target.access === "readonly" ? "ro" : "rw"})`)
      .join(", ");

    await gitCommitFiles({
      message: `feat(nas): mount ${body.share}/${subfolder || "/"} into ${summary}`,
      addOrUpdateFiles,
    });
    await auditLog("nas:mount", actor, `mounted ${body.provider}/${body.share}/${subfolder || "/"} into ${summary}`);

    return NextResponse.json({
      ok: true,
      subfolder,
      files: addOrUpdateFiles.map((file) => file.path),
      mounts: body.targets.map((target) => ({
        namespace: target.namespace,
        workload: target.workload,
        access: target.access,
        mountPath: target.mount_path,
        ...deriveNasResourceNames(identityFor(target.namespace, target.access)),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const DELETE = withAuth({ logMutating: true }, async ({ req, session }) => {
  const actor = session.user?.email ?? "unauthenticated";
  const rbac = await getSessionRBACContext(session, 60);
  if (!canWriteStorage(rbac) || !hasSessionPermission(rbac, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("nas-unmount-workload", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const parsed = DeleteBody.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const body = parsed.data;
    if (!isAllowedManifestPath(body.manifest_path)) {
      return NextResponse.json({ error: "manifest_path must be under kubernetes/catalog/" }, { status: 400 });
    }

    let subfolder: string;
    try {
      subfolder = normalizeSubfolder(body.subfolder);
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 400 });
    }

    const resolvedProvider = await requireNasProvider(body.provider, "named");
    if (resolvedProvider.response) return resolvedProvider.response;
    const provider = resolvedProvider.provider;

    // Same authority as mounting: an unmount the ACL would have blocked as a
    // mount must not be reachable either.
    const decision = nasAccessDecision(rbac, {
      provider: body.provider,
      share: body.share,
      subfolder,
      access: body.access,
    });
    if (!decision.allowed) {
      return NextResponse.json({ error: `NAS folder ACL denied: ${decision.reason}` }, { status: 403 });
    }

    const identity: NasVolumeIdentity = {
      provider: body.provider,
      backend: provider.backends[0],
      host: provider.host,
      share: body.share,
      subfolder,
      namespace: body.namespace,
      access: body.access,
    };
    const names = deriveNasResourceNames(identity);

    const existing = await gitReadFile(body.manifest_path);
    if (!existing) return NextResponse.json({ error: `Manifest not found: ${body.manifest_path}` }, { status: 404 });
    const yaml = await import("js-yaml");
    const docs = yaml.loadAll(existing.content) as unknown[];
    const workload = findWorkload(docs, body.kind, body.workload, body.namespace);
    if (!workload) return NextResponse.json({ error: `${body.kind} ${body.namespace}/${body.workload} not found` }, { status: 404 });

    const podSpec = workload.spec?.template?.spec;
    let changed = false;
    if (podSpec?.volumes) {
      const before = podSpec.volumes.length;
      podSpec.volumes = podSpec.volumes.filter((volume) => volume.persistentVolumeClaim?.claimName !== names.pvcName);
      changed = podSpec.volumes.length !== before;
    }
    for (const container of podSpec?.containers ?? []) {
      if (!container.volumeMounts) continue;
      const before = container.volumeMounts.length;
      container.volumeMounts = container.volumeMounts.filter((mount) => mount.name !== names.volumeName);
      changed = changed || container.volumeMounts.length !== before;
    }
    if (!changed) return NextResponse.json({ ok: true, removed: false });

    // The PV/PVC manifest goes with it. `persistentVolumeReclaimPolicy: Retain`
    // plus the absence of any provisioner means the NAS directory and its
    // contents survive — deleting a mount never deletes data.
    await gitCommitFiles({
      message: `feat(nas): unmount ${body.share}/${subfolder || "/"} from ${body.namespace}/${body.workload}`,
      addOrUpdateFiles: [{
        path: body.manifest_path,
        content: docs.map((doc) => yaml.dump(doc, { lineWidth: -1, indent: 2 })).join("---\n"),
      }],
      deleteFiles: [deriveNasManifestPath(identity)],
    });
    await auditLog("nas:unmount", actor, `unmounted ${body.share}/${subfolder || "/"} from ${body.namespace}/${body.workload}`);

    return NextResponse.json({ ok: true, removed: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
