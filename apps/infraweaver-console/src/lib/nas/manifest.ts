// NAS volume manifest generator — the single renderer behind every NAS mount.
//
// Plan reference: plans/advanced-storage.md §3 (least-privilege) and §7.
//
// Why static PersistentVolumes, not a StorageClass
// ------------------------------------------------
// This module used to emit a StorageClass + dynamically-provisioned PVC. Two
// properties of `smb.csi.k8s.io` make that wrong for mounting an *existing* NAS
// folder, and both are silent:
//
//   1. `subDir: ""` does not mean "the share root" — the driver substitutes the
//      generated PV name, so the pod silently mounts `//host/share/pvc-<uuid>`.
//   2. `onDelete` defaults to `delete`. Removing the PV makes the CSI controller
//      recursively delete the directory *on the NAS*. A GitOps revert would eat
//      the media library.
//
// A static PV states the target directory explicitly, is pre-bound to its PVC
// via `claimRef`, has `persistentVolumeReclaimPolicy: Retain`, and gives the CSI
// controller no provisioning path to delete anything. The folder is created
// up-front through the appliance's own API (see `@/lib/nas/discovery`).
//
// Volume identity
// ---------------
// A volume is identified by (provider, share, subfolder, access, namespace) —
// deliberately NOT by workload. Two Deployments in one namespace that mount the
// same folder at the same access mode share one PV/PVC. Two namespaces (say
// jellyfin RO and nextcloud RW) get their own PV/PVC pointing at the same
// directory on the NAS. That is what makes one folder mountable by N pods.
//
// Security invariants (all three layers, none redundant)
//   Layer A (NAS)  — `access` selects the RO or RW service account credential.
//   Layer B (node) — `mountOptions: [ro]` + `csi.readOnly` make the kernel mount
//                    read-only; a write returns EROFS.
//   Layer C (pod)  — the consumer sets `volumeMounts[].readOnly: true`.
//
// Backend abstraction: adding a CSI (democratic-csi, ceph-fs, …) means adding a
// case to `renderCsiSource` and whitelisting the value in `NasBackend`.

import { createHash } from "node:crypto";
import { joinNasPath, normalizeSubfolder, slugifyPathSegment } from "@/lib/nas/paths";

export type NasBackend = "smb" | "nfs";
export type NasAccess = "readonly" | "readwrite";

/** The tuple that uniquely identifies a NAS-backed volume in the cluster. */
export interface NasVolumeIdentity {
  /** Provider id from the registry (`truenas`, `synology`, …). */
  provider: string;
  /** Storage backend. Determines which CSI driver the PV targets. */
  backend: NasBackend;
  /** NAS host (IP or DNS) used to build the mount source. */
  host: string;
  /** SMB share name. */
  share: string;
  /** Absolute path of the share on the appliance — required for NFS exports. */
  sharePath?: string;
  /** Normalized share-relative subfolder. `""` mounts the share root. */
  subfolder: string;
  /** Namespace the PVC (and its consuming workloads) live in. */
  namespace: string;
  /** Access mode: selects credential, kernel RO flag, and labels. */
  access: NasAccess;
}

export interface NasResourceNames {
  /** Cluster-scoped, so it folds in the namespace and a content hash. */
  pvName: string;
  /** Namespaced: shared by every workload in the namespace mounting this folder. */
  pvcName: string;
  /** Pod-spec volume name. */
  volumeName: string;
  /** CSI credential Secret, one per (provider, access) per namespace. */
  secretName: string;
}

function accessSuffix(access: NasAccess): "ro" | "rw" {
  return access === "readonly" ? "ro" : "rw";
}

/** Short, stable discriminator so two different folders never collide after slug truncation. */
function identityHash(identity: NasVolumeIdentity): string {
  const canonical = [
    identity.provider,
    identity.host,
    identity.share,
    normalizeSubfolder(identity.subfolder),
    identity.access,
    identity.namespace,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/**
 * CSI credential Secret name for a (provider, access) pair. One per namespace.
 * Kept in one place so the PV's `nodeStageSecretRef` and the ExternalSecret that
 * materialises it can never disagree.
 */
export function deriveNasSecretName(provider: string, access: NasAccess): string {
  return `nas-${slugifyPathSegment(provider)}-${accessSuffix(access)}`;
}

/** Every Kubernetes object name for a NAS volume, derived from its identity. */
export function deriveNasResourceNames(identity: NasVolumeIdentity): NasResourceNames {
  const suffix = accessSuffix(identity.access);
  const shareSlug = slugifyPathSegment(identity.share);
  // `""` (share root) slugs to `root`, so a root mount and a `root/` subfolder
  // are still separated by the identity hash below.
  const subSlug = slugifyPathSegment(normalizeSubfolder(identity.subfolder));
  const nsSlug = slugifyPathSegment(identity.namespace);
  return {
    pvName: `nas-${nsSlug}-${shareSlug}-${subSlug}-${suffix}-${identityHash(identity)}`.slice(0, 253),
    pvcName: `nas-${shareSlug}-${subSlug}-${suffix}`.slice(0, 253),
    volumeName: `nas-${subSlug}-${suffix}`.slice(0, 63),
    secretName: deriveNasSecretName(identity.provider, identity.access),
  };
}

/** GitOps path for a volume's generated PV+PVC manifest. */
export function deriveNasManifestPath(identity: NasVolumeIdentity): string {
  const names = deriveNasResourceNames(identity);
  return `kubernetes/catalog/nas-shares/${names.pvName}.yaml`;
}

/** GitOps path for a namespace's generated credential ExternalSecret. */
export function deriveNasSecretManifestPath(namespace: string, provider: string, access: NasAccess): string {
  const secretName = deriveNasSecretName(provider, access);
  return `kubernetes/catalog/nas-shares/${slugifyPathSegment(namespace)}-${secretName}.yaml`;
}

interface CsiSource {
  driver: string;
  volumeHandle: string;
  volumeAttributes: Record<string, string>;
  /** SMB authenticates per-mount; NFS uses host-based export ACLs and has no secret. */
  needsSecret: boolean;
}

function renderCsiSource(identity: NasVolumeIdentity, pvName: string): CsiSource {
  const subfolder = normalizeSubfolder(identity.subfolder);
  if (identity.backend === "nfs") {
    if (!identity.sharePath) {
      throw new Error("An NFS mount requires the share's absolute path on the appliance");
    }
    return {
      driver: "nfs.csi.k8s.io",
      // `pvName` keeps the handle unique when the same export is mounted by two
      // namespaces at different access modes.
      volumeHandle: `${identity.host}#${joinNasPath(identity.sharePath, subfolder)}#${pvName}`,
      volumeAttributes: {
        server: identity.host,
        share: joinNasPath(identity.sharePath, subfolder),
      },
      needsSecret: false,
    };
  }
  return {
    driver: "smb.csi.k8s.io",
    volumeHandle: `${identity.host}/${identity.share}#${subfolder}#${pvName}`,
    volumeAttributes: {
      source: `//${identity.host}/${identity.share}`,
      // Explicit, always. An empty `subDir` would make the driver invent one.
      ...(subfolder ? { subDir: subfolder } : {}),
    },
    needsSecret: true,
  };
}

function volumeLabels(identity: NasVolumeIdentity): Record<string, string> {
  return {
    "infraweaver.io/nas-share": "true",
    "infraweaver.io/provider": identity.provider,
    "infraweaver.io/backend": identity.backend,
    "infraweaver.io/access": accessSuffix(identity.access),
    "infraweaver.io/share": slugifyPathSegment(identity.share),
    "infraweaver.io/subfolder": slugifyPathSegment(normalizeSubfolder(identity.subfolder)),
  };
}

export interface GenerateVolumeParams extends NasVolumeIdentity {
  /**
   * Requested capacity. Advisory for SMB/NFS (neither CSI enforces a quota) but
   * recorded on the PV/PVC so the storage pie and `kubectl get pvc` read sanely.
   */
  size?: string;
}

/**
 * Render the static PersistentVolume + PersistentVolumeClaim for one NAS folder
 * in one namespace at one access mode.
 *
 * The PV is pre-bound with `claimRef`, so the RO PV can never be claimed by the
 * PVC that was meant to bind the RW one (they share a `source` and differ only
 * in credential and mount flags).
 */
export function generateNasVolumeManifest(
  params: GenerateVolumeParams,
  yamlLib: Pick<typeof import("js-yaml"), "dump">,
): string {
  const readOnly = params.access === "readonly";
  const names = deriveNasResourceNames(params);
  const csi = renderCsiSource(params, names.pvName);
  const size = params.size ?? "100Gi";
  const labels = volumeLabels(params);

  const persistentVolume = {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: names.pvName, labels },
    spec: {
      capacity: { storage: size },
      // Neither CSI honours ReadOnlyMany for binding; RO is enforced by the
      // credential, the kernel mount options, and the pod's volumeMount.
      accessModes: ["ReadWriteMany"],
      persistentVolumeReclaimPolicy: "Retain",
      // Empty string opts out of dynamic provisioning entirely: no controller
      // ever calls CreateVolume/DeleteVolume for this PV, so the NAS directory
      // has no code path that could delete it.
      storageClassName: "",
      claimRef: { namespace: params.namespace, name: names.pvcName },
      ...(readOnly ? { mountOptions: ["ro"] } : {}),
      csi: {
        driver: csi.driver,
        volumeHandle: csi.volumeHandle,
        volumeAttributes: csi.volumeAttributes,
        ...(readOnly ? { readOnly: true } : {}),
        ...(csi.needsSecret
          ? { nodeStageSecretRef: { name: names.secretName, namespace: params.namespace } }
          : {}),
      },
    },
  };

  const persistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: names.pvcName, namespace: params.namespace, labels },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: "",
      volumeName: names.pvName,
      resources: { requests: { storage: size } },
    },
  };

  return [persistentVolume, persistentVolumeClaim]
    .map((document) => yamlLib.dump(document, { lineWidth: -1, indent: 2 }))
    .join("---\n");
}

/**
 * ExternalSecret that materialises a provider's SMB credential Secret from
 * OpenBao into a consuming namespace. Emitted alongside the PV/PVC so the CSI
 * node plugin has a Secret to authenticate with — no plaintext creds in git.
 *
 * `credsLogicalPath` is the OpenBao logical path (e.g. `platform/nas/creds/truenas-ro`);
 * the ClusterSecretStore `openbao` resolves it against the `secret/` KV mount.
 */
export function generateNasCredentialExternalSecret(params: {
  namespace: string;
  provider: string;
  access: NasAccess;
  credsLogicalPath: string;
  yamlLib: Pick<typeof import("js-yaml"), "dump">;
}): string {
  const { namespace, provider, access, credsLogicalPath, yamlLib } = params;
  const secretName = deriveNasSecretName(provider, access);
  const remoteKey = `secret/${credsLogicalPath}`;
  const document = {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: {
      name: secretName,
      namespace,
      labels: {
        "infraweaver.io/nas-share": "true",
        "infraweaver.io/component": "nas-credentials",
        "infraweaver.io/provider": provider,
        "infraweaver.io/access": accessSuffix(access),
      },
    },
    spec: {
      // Canonical Go duration. ESO stores `1h` as `1h0m0s`, which ArgoCD then
      // reports as permanent drift on every generated ExternalSecret.
      refreshInterval: "1h0m0s",
      secretStoreRef: { name: "openbao", kind: "ClusterSecretStore" },
      // Retain on an OpenBao outage so live mounts survive while ESO retries.
      target: { name: secretName, creationPolicy: "Owner", deletionPolicy: "Retain" },
      data: [
        { secretKey: "username", remoteRef: { key: remoteKey, property: "username" } },
        { secretKey: "password", remoteRef: { key: remoteKey, property: "password" } },
      ],
    },
  };
  return yamlLib.dump(document, { lineWidth: -1, indent: 2 });
}
