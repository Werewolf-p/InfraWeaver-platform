// Security-invariant tests for the NAS assign manifest generator.
//
// Plan reference: plans/advanced-storage.md §3 (least-privilege folder model)
// and §7 Phase 1. `access: "readonly"` MUST render into a manifest that:
//   a) mounts the RO NAS credential (nas-<share>-ro), not the RW one, and
//   b) enforces a read-only mount at the storage-class layer (mountOptions: [ro]).
//
// If any of these assertions regress, a compromised Jellyfin pod could write
// upstream to the shared media folder — the exact vulnerability Phase 1 fixes.

import * as yaml from "js-yaml";
import { generateK8sManifest } from "@/lib/nas/manifest";

interface StorageClassManifest {
  kind: string;
  metadata: { name: string };
  mountOptions?: string[];
  provisioner?: string;
  parameters: Record<string, string>;
}

interface PvcManifest {
  kind: string;
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: { accessModes: string[]; storageClassName: string };
}

function loadDocs(rendered: string) {
  const docs = yaml.loadAll(rendered) as Array<StorageClassManifest | PvcManifest>;
  const sc = docs.find((d) => d.kind === "StorageClass") as StorageClassManifest;
  const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim") as PvcManifest;
  return { sc, pvc };
}

const BASE = {
  username: "jellyfin",
  provider: "synology",
  backend: "smb" as const,
  share: "media",
  subfolder: "",
  pvc_name: "jellyfin-media",
  pvc_namespace: "jellyfin",
  host: "10.25.0.21",
} as const;

describe("generateK8sManifest — least-privilege invariants", () => {
  it("readonly assignment renders a read-only StorageClass + RO credential", () => {
    const rendered = generateK8sManifest({ ...BASE, access: "readonly" }, yaml);
    const { sc, pvc } = loadDocs(rendered);

    // Layer B: RO NAS identity, not the RW one.
    expect(sc.parameters["csi.storage.k8s.io/node-stage-secret-name"]).toBe("nas-media-ro");
    expect(sc.parameters["csi.storage.k8s.io/provisioner-secret-name"]).toBe("nas-media-ro");
    // Must not silently reference the old shared or RW secret.
    expect(sc.parameters["csi.storage.k8s.io/node-stage-secret-name"]).not.toBe("synology-smb-credentials");
    expect(sc.parameters["csi.storage.k8s.io/node-stage-secret-name"]).not.toBe("nas-media-rw");

    // Layer C (defense-in-depth): kernel-level RO mount option.
    expect(sc.mountOptions).toEqual(expect.arrayContaining(["ro"]));

    // Labeling for the unified storage-page mounts view.
    expect(pvc.metadata.labels?.["infraweaver.io/access"]).toBe("ro");
    expect(pvc.metadata.labels?.["infraweaver.io/nas-share"]).toBe("true");
  });

  it("readwrite assignment renders a writable StorageClass + RW credential", () => {
    const rendered = generateK8sManifest({ ...BASE, username: "nextcloud", pvc_name: "nextcloud-media", pvc_namespace: "nextcloud", access: "readwrite" }, yaml);
    const { sc, pvc } = loadDocs(rendered);

    expect(sc.parameters["csi.storage.k8s.io/node-stage-secret-name"]).toBe("nas-media-rw");
    expect(sc.mountOptions).toBeUndefined();
    expect(pvc.metadata.labels?.["infraweaver.io/access"]).toBe("rw");
  });

  it("share source + subDir stay scoped to the requested folder (no traversal)", () => {
    const rendered = generateK8sManifest({ ...BASE, subfolder: "movies", access: "readonly" }, yaml);
    const { sc } = loadDocs(rendered);
    expect(sc.parameters.source).toBe("//10.25.0.21/media");
    expect(sc.parameters.subDir).toBe("movies");
  });

  it("StorageClass name distinguishes RO vs RW so k8s cannot conflate them", () => {
    const ro = loadDocs(generateK8sManifest({ ...BASE, access: "readonly" }, yaml)).sc;
    const rw = loadDocs(generateK8sManifest({ ...BASE, access: "readwrite" }, yaml)).sc;
    expect(ro.metadata.name).not.toBe(rw.metadata.name);
    expect(ro.metadata.name).toMatch(/-ro$/);
    expect(rw.metadata.name).toMatch(/-rw$/);
  });

  it("NFS backend renders nfs.csi.k8s.io with server/share, no secret", () => {
    const rendered = generateK8sManifest({
      ...BASE,
      backend: "nfs",
      share: "media",
      subfolder: "movies",
      access: "readonly",
    }, yaml);
    const { sc } = loadDocs(rendered);
    expect(sc).toBeDefined();
    expect(sc.provisioner).toBe("nfs.csi.k8s.io");
    expect(sc.parameters.server).toBe("10.25.0.21");
    expect(sc.parameters.share).toBe("media/movies");
    // NFS driver ignores secret keys but they must not leak in either.
    expect(sc.parameters["csi.storage.k8s.io/node-stage-secret-name"]).toBeUndefined();
    // RO invariant still applies.
    expect(sc.mountOptions).toEqual(expect.arrayContaining(["ro"]));
    // Backend label so the mounts view can filter.
    expect(sc.metadata.name).toMatch(/^nfs-/);
  });

  it("size parameter propagates to the PVC (advisory but visible)", () => {
    const rendered = generateK8sManifest({ ...BASE, access: "readwrite", size: "500Gi" }, yaml);
    const docs = yaml.loadAll(rendered) as Array<{ kind: string; spec?: { resources?: { requests?: { storage?: string } } } }>;
    const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim");
    expect(pvc?.spec?.resources?.requests?.storage).toBe("500Gi");
  });
});
