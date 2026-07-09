// Security-invariant tests for the NAS volume manifest generator.
//
// Plan reference: plans/advanced-storage.md §3 (least-privilege folder model).
//
// Three invariants, each of which has a concrete failure mode if it regresses:
//
//   a) `access: "readonly"` renders the RO credential AND a kernel-level
//      read-only mount. Otherwise a compromised Jellyfin pod writes upstream
//      into the shared media folder.
//   b) The generated PV never lets the CSI driver delete data on the NAS:
//      reclaimPolicy Retain + `storageClassName: ""` (no provisioner), and the
//      SMB `subDir` is always explicit. An empty `subDir` makes smb.csi.k8s.io
//      substitute the PV name, silently mounting the wrong directory.
//   c) Two different folders (or access modes) never collide on an object name,
//      and a PV is pre-bound to its own PVC via `claimRef` — otherwise the RO
//      PVC could bind the RW PV, which shares the same `source`.

import * as yaml from "js-yaml";
import {
  deriveNasResourceNames,
  deriveNasSecretName,
  generateNasCredentialExternalSecret,
  generateNasVolumeManifest,
  type NasVolumeIdentity,
} from "@/lib/nas/manifest";

interface PvManifest {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: {
    capacity: { storage: string };
    accessModes: string[];
    persistentVolumeReclaimPolicy: string;
    storageClassName: string;
    claimRef: { namespace: string; name: string };
    mountOptions?: string[];
    csi: {
      driver: string;
      volumeHandle: string;
      volumeAttributes: Record<string, string>;
      readOnly?: boolean;
      nodeStageSecretRef?: { name: string; namespace: string };
    };
  };
}

interface PvcManifest {
  kind: string;
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: { accessModes: string[]; storageClassName: string; volumeName: string };
}

const BASE: NasVolumeIdentity = {
  provider: "truenas",
  backend: "smb",
  host: "10.25.0.135",
  share: "infraweaver",
  sharePath: "/mnt/Main/infraweaver",
  subfolder: "media",
  namespace: "jellyfin",
  access: "readonly",
};

function parse(identity: NasVolumeIdentity, size?: string) {
  const docs = yaml.loadAll(generateNasVolumeManifest({ ...identity, size }, yaml)) as unknown[];
  const pv = docs.find((d) => (d as PvManifest).kind === "PersistentVolume") as PvManifest;
  const pvc = docs.find((d) => (d as PvcManifest).kind === "PersistentVolumeClaim") as PvcManifest;
  return { pv, pvc };
}

describe("readonly renders a read-only mount (invariant A)", () => {
  it("selects the RO credential secret", () => {
    const { pv } = parse(BASE);
    expect(pv.spec.csi.nodeStageSecretRef).toEqual({ name: "nas-truenas-ro", namespace: "jellyfin" });
  });

  it("sets kernel read-only mount options and csi.readOnly", () => {
    const { pv } = parse(BASE);
    expect(pv.spec.mountOptions).toEqual(["ro"]);
    expect(pv.spec.csi.readOnly).toBe(true);
  });

  it("labels the volume ro so /api/nas/mounts reports it correctly", () => {
    const { pv, pvc } = parse(BASE);
    expect(pv.metadata.labels?.["infraweaver.io/access"]).toBe("ro");
    expect(pvc.metadata.labels?.["infraweaver.io/access"]).toBe("ro");
  });

  it("readwrite selects the RW credential and omits every read-only flag", () => {
    const { pv } = parse({ ...BASE, access: "readwrite", namespace: "nextcloud" });
    expect(pv.spec.csi.nodeStageSecretRef).toEqual({ name: "nas-truenas-rw", namespace: "nextcloud" });
    expect(pv.spec.mountOptions).toBeUndefined();
    expect(pv.spec.csi.readOnly).toBeUndefined();
  });
});

describe("the CSI driver can never delete NAS data (invariant B)", () => {
  it("retains the volume and opts out of dynamic provisioning", () => {
    const { pv, pvc } = parse(BASE);
    expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Retain");
    // "" means: no provisioner, so no DeleteVolume call can ever reach the NAS.
    expect(pv.spec.storageClassName).toBe("");
    expect(pvc.spec.storageClassName).toBe("");
  });

  it("always writes an explicit subDir, because an empty one means 'invent a directory'", () => {
    const { pv } = parse(BASE);
    expect(pv.spec.csi.volumeAttributes.subDir).toBe("media");
    expect(pv.spec.csi.volumeAttributes.source).toBe("//10.25.0.135/infraweaver");
  });

  it("omits subDir entirely for a share-root mount rather than emitting an empty string", () => {
    const { pv } = parse({ ...BASE, subfolder: "" });
    expect(pv.spec.csi.volumeAttributes).not.toHaveProperty("subDir");
    expect(pv.spec.csi.volumeAttributes.source).toBe("//10.25.0.135/infraweaver");
  });

  it("preserves a nested subfolder verbatim", () => {
    const { pv } = parse({ ...BASE, subfolder: "media/movies" });
    expect(pv.spec.csi.volumeAttributes.subDir).toBe("media/movies");
  });

  it("refuses a traversal in the subfolder", () => {
    expect(() => parse({ ...BASE, subfolder: "../../etc" })).toThrow(/traversal/i);
  });
});

describe("names and binding are collision-free (invariant C)", () => {
  it("pre-binds the PV to its own PVC", () => {
    const { pv, pvc } = parse(BASE);
    expect(pv.spec.claimRef).toEqual({ namespace: "jellyfin", name: pvc.metadata.name });
    expect(pvc.spec.volumeName).toBe(pv.metadata.name);
    expect(pvc.metadata.namespace).toBe("jellyfin");
  });

  it("gives RO and RW volumes on the same folder distinct names", () => {
    const ro = deriveNasResourceNames(BASE);
    const rw = deriveNasResourceNames({ ...BASE, access: "readwrite" });
    expect(ro.pvName).not.toBe(rw.pvName);
    expect(ro.pvcName).not.toBe(rw.pvcName);
    expect(ro.secretName).not.toBe(rw.secretName);
  });

  it("gives two subfolders of one share distinct names (the old generator collided here)", () => {
    const media = deriveNasResourceNames(BASE);
    const photos = deriveNasResourceNames({ ...BASE, subfolder: "photos" });
    expect(media.pvName).not.toBe(photos.pvName);
    expect(media.pvcName).not.toBe(photos.pvcName);
    expect(media.volumeName).not.toBe(photos.volumeName);
  });

  it("separates the same folder mounted into two namespaces at PV scope", () => {
    const jellyfin = deriveNasResourceNames(BASE);
    const nextcloud = deriveNasResourceNames({ ...BASE, namespace: "nextcloud" });
    // PVs are cluster-scoped, so they must differ...
    expect(jellyfin.pvName).not.toBe(nextcloud.pvName);
    // ...while the namespaced PVC name may safely repeat.
    expect(jellyfin.pvcName).toBe(nextcloud.pvcName);
  });

  it("keeps two deeply-nested folders apart even after slug truncation", () => {
    const long = "a".repeat(60);
    const first = deriveNasResourceNames({ ...BASE, subfolder: `${long}/one` });
    const second = deriveNasResourceNames({ ...BASE, subfolder: `${long}/two` });
    expect(first.pvName).not.toBe(second.pvName);
  });

  it("produces names within Kubernetes limits", () => {
    const names = deriveNasResourceNames({ ...BASE, subfolder: "a".repeat(90), namespace: "b".repeat(60) });
    expect(names.pvName.length).toBeLessThanOrEqual(253);
    expect(names.pvcName.length).toBeLessThanOrEqual(253);
    expect(names.volumeName.length).toBeLessThanOrEqual(63);
    for (const name of [names.pvName, names.pvcName, names.volumeName, names.secretName]) {
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("NFS backend", () => {
  it("targets the NFS CSI with a fully-resolved export path and no secret", () => {
    const { pv } = parse({ ...BASE, backend: "nfs", access: "readwrite" });
    expect(pv.spec.csi.driver).toBe("nfs.csi.k8s.io");
    expect(pv.spec.csi.volumeAttributes).toEqual({
      server: "10.25.0.135",
      share: "/mnt/Main/infraweaver/media",
    });
    expect(pv.spec.csi.nodeStageSecretRef).toBeUndefined();
  });

  it("still enforces read-only at the kernel for an RO NFS mount", () => {
    const { pv } = parse({ ...BASE, backend: "nfs" });
    expect(pv.spec.mountOptions).toEqual(["ro"]);
    expect(pv.spec.csi.readOnly).toBe(true);
  });

  it("refuses an NFS mount without the share's absolute path", () => {
    expect(() => parse({ ...BASE, backend: "nfs", sharePath: undefined })).toThrow(/absolute path/i);
  });
});

describe("credential ExternalSecret", () => {
  it("maps the per-access OpenBao path to the secret the PV references", () => {
    const doc = yaml.load(generateNasCredentialExternalSecret({
      namespace: "jellyfin",
      provider: "truenas",
      access: "readonly",
      credsLogicalPath: "platform/nas/creds/truenas-ro",
      yamlLib: yaml,
    })) as {
      metadata: { name: string; namespace: string };
      spec: { target: { name: string; deletionPolicy: string }; data: Array<{ secretKey: string; remoteRef: { key: string; property: string } }> };
    };
    expect(doc.metadata.name).toBe(deriveNasSecretName("truenas", "readonly"));
    expect(doc.metadata.namespace).toBe("jellyfin");
    expect(doc.spec.data.map((d) => d.remoteRef.key)).toEqual([
      "secret/platform/nas/creds/truenas-ro",
      "secret/platform/nas/creds/truenas-ro",
    ]);
    expect(doc.spec.data.map((d) => d.secretKey).sort()).toEqual(["password", "username"]);
    // An OpenBao outage must not tear the credential out from under a live mount.
    expect(doc.spec.target.deletionPolicy).toBe("Retain");
  });

  it("never embeds a credential value in the manifest", () => {
    const rendered = generateNasCredentialExternalSecret({
      namespace: "jellyfin",
      provider: "truenas",
      access: "readwrite",
      credsLogicalPath: "platform/nas/creds/truenas-rw",
      yamlLib: yaml,
    });
    expect(rendered).not.toMatch(/password:\s*\S+/);
    expect(rendered).toContain("secretKey: password");
  });
});
