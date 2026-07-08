// NAS assign manifest generator — extracted from the route handler so it can be
// unit-tested without booting Next's runtime (which pulls in a global Request).
//
// Plan reference: plans/advanced-storage.md §3 (least-privilege) and §7 Phase 1.
// The security invariant: `access: "readonly"` must render into a manifest that
// uses the RO NAS credential AND enforces a kernel-level read-only mount.
//
// Backend abstraction
// -------------------
// This module is deliberately backend-agnostic. Adding a new CSI (democratic-
// csi, ceph-fs, etc.) means (a) adding a case to `renderStorageClass` and
// (b) whitelisting the new value in `NasBackend`. Consumers (assign,
// mount-workload) never need to change.

export type NasBackend = "smb" | "nfs";
export type NasAccess = "readonly" | "readwrite";

export interface GenerateManifestParams {
  /** Owning app or user, used only for naming the SC/PVC uniquely. */
  username: string;
  /** Provider id from the registry (`synology`, `truenas`, …). */
  provider: string;
  /** Storage backend (SMB or NFS). Determines which CSI is targeted. */
  backend: NasBackend;
  /** Share name (SMB) or export path leaf (NFS). */
  share: string;
  /** Optional subfolder scope inside the share. Empty string = share root. */
  subfolder: string;
  /** Namespace-scoped PVC name to bind the workload to. */
  pvc_name: string;
  /** Namespace the PVC lives in. */
  pvc_namespace: string;
  /** NAS host (IP or DNS). */
  host: string;
  /** Access mode; controls credential + kernel RO flag + label. */
  access: NasAccess;
  /**
   * Requested storage size. Advisory for SMB/NFS (both CSIs ignore capacity)
   * but recorded on the PVC so operators and pie charts see meaningful numbers.
   */
  size?: string;
}

/** How the CSI provisioner and its parameters differ per backend. */
interface BackendRender {
  provisioner: string;
  parameters: Record<string, string>;
  /** Mount options that make sense for the backend when RO is requested. */
  readOnlyMountOptions: string[];
}

function renderBackend(params: GenerateManifestParams, secretName: string): BackendRender {
  const { backend, host, share, subfolder, pvc_namespace } = params;
  if (backend === "nfs") {
    return {
      provisioner: "nfs.csi.k8s.io",
      parameters: {
        server: host,
        // For NFS the "share" is the export path; consumers pass e.g. "/mnt/tank/media"
        // and the optional subfolder is appended.
        share: subfolder ? `${share.replace(/\/$/, "")}/${subfolder}` : share,
      },
      readOnlyMountOptions: ["ro"],
    };
  }
  // Default: SMB CSI (matches what the cluster ships today, see
  // kubernetes/core/csi-driver-smb).
  return {
    provisioner: "smb.csi.k8s.io",
    parameters: {
      source: `//${host}/${share}`,
      subDir: subfolder,
      "csi.storage.k8s.io/provisioner-secret-name": secretName,
      "csi.storage.k8s.io/provisioner-secret-namespace": pvc_namespace,
      "csi.storage.k8s.io/node-stage-secret-name": secretName,
      "csi.storage.k8s.io/node-stage-secret-namespace": pvc_namespace,
    },
    readOnlyMountOptions: ["ro"],
  };
}

/** SMB CSI credential Secret name for a share/access pair. Kept in one place so
 *  the StorageClass parameters and the ExternalSecret that materialises the
 *  Secret always agree. */
export function deriveNasSecretName(share: string, access: NasAccess): string {
  const accessSuffix = access === "readonly" ? "ro" : "rw";
  return `nas-${share.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${accessSuffix}`;
}

/**
 * ExternalSecret that materialises a share's SMB credential Secret from OpenBao.
 * Emitted alongside the SC/PVC for dynamically-added SMB providers so the CSI
 * driver has a Secret to authenticate with — no plaintext credentials in git.
 *
 * `credsLogicalPath` is the OpenBao logical path (e.g. `platform/nas/creds/foo`);
 * the ClusterSecretStore `openbao` resolves it against the `secret/` KV mount.
 */
export function generateNasCredentialExternalSecret(params: {
  secretName: string;
  namespace: string;
  access: NasAccess;
  credsLogicalPath: string;
  yamlLib: Pick<typeof import("js-yaml"), "dump">;
}): string {
  const { secretName, namespace, access, credsLogicalPath, yamlLib } = params;
  const remoteKey = `secret/${credsLogicalPath}`;
  const doc = {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: {
      name: secretName,
      namespace,
      labels: {
        "infraweaver.io/nas-share": "true",
        "infraweaver.io/component": "nas-credentials",
        "infraweaver.io/access": access === "readonly" ? "ro" : "rw",
      },
    },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "openbao", kind: "ClusterSecretStore" },
      target: { name: secretName, creationPolicy: "Owner", deletionPolicy: "Retain" },
      data: [
        { secretKey: "username", remoteRef: { key: remoteKey, property: "username" } },
        { secretKey: "password", remoteRef: { key: remoteKey, property: "password" } },
      ],
    },
  };
  return yamlLib.dump(doc, { lineWidth: -1, indent: 2 });
}

export function generateK8sManifest(
  params: GenerateManifestParams,
  yamlLib: Pick<typeof import("js-yaml"), "dump">,
): string {
  const { username, provider, share, pvc_name, pvc_namespace, access, backend } = params;
  const readOnly = access === "readonly";
  const accessSuffix = readOnly ? "ro" : "rw";
  // Per-app + per-access credential separation (plan §3-B). ESO provisions
  // `nas-<share>-<ro|rw>` into the consuming namespace, sourced from OpenBao.
  // NOTE: NFS has no per-client credential (host-based auth), but we still
  // derive the name so future secret-based NFS drivers slot in unchanged.
  const secretName = deriveNasSecretName(share, access);
  const scName = `${backend}-${username}-${share.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${accessSuffix}`;
  const backendRender = renderBackend(params, secretName);
  const size = params.size ?? "100Gi";
  const documents: object[] = [
    {
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: {
        name: scName,
        labels: {
          "infraweaver.io/nas-share": "true",
          "infraweaver.io/provider": provider,
          "infraweaver.io/backend": backend,
          "infraweaver.io/access": accessSuffix,
        },
      },
      provisioner: backendRender.provisioner,
      reclaimPolicy: "Retain",
      volumeBindingMode: "Immediate",
      allowVolumeExpansion: false,
      // Kernel-level RO mount (Layer C). Any write syscall returns EROFS even
      // if the RO NAS account were mis-scoped.
      ...(readOnly ? { mountOptions: backendRender.readOnlyMountOptions } : {}),
      parameters: backendRender.parameters,
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvc_name,
        namespace: pvc_namespace,
        labels: {
          "infraweaver.io/nas-share": "true",
          "infraweaver.io/user": username,
          "infraweaver.io/provider": provider,
          "infraweaver.io/backend": backend,
          "infraweaver.io/access": accessSuffix,
        },
      },
      spec: {
        // Neither smb.csi.k8s.io nor nfs.csi.k8s.io honours ReadOnlyMany; the
        // RO invariant is enforced by (a) the RO NAS credential (SMB) or
        // export ACL (NFS), (b) mountOptions on the SC, and (c) the pod
        // volumeMount `readOnly: true`.
        accessModes: ["ReadWriteMany"],
        storageClassName: scName,
        resources: { requests: { storage: size } },
      },
    },
  ];

  return documents.map((document) => yamlLib.dump(document, { lineWidth: -1, indent: 2 })).join("---\n");
}
