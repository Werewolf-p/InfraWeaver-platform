/**
 * Image supply-chain integrity — PURE (no Trivy, no k8s; unit-testable).
 *
 * The old page had a single `isTrusted` boolean. This classifies each running
 * image's PIN STATUS — a mutable tag (`:latest`, `:main`) can silently change
 * under the same reference, so digest-pinning is the real supply-chain signal.
 */

export type PinStatus = "pinned-digest" | "tagged" | "mutable-tag" | "floating-latest" | "no-tag";

/** Tags that move — the same reference can resolve to different content over time. */
export const MUTABLE_TAGS = ["stable", "main", "master", "edge", "dev", "develop", "test", "nightly", "prod"];
/** Registries considered trusted (in-cluster mirror + GitHub Container Registry). */
export const TRUSTED_REGISTRY_MARKERS = ["svc.cluster.local", "ghcr.io", "zot"];

export interface RunningImage {
  image: string;
  registry: string;
  pods: number;
  namespaces: string[];
}

export interface SupplyChainFinding {
  image: string;
  registry: string;
  pinStatus: PinStatus;
  pods: number;
  namespaces: string[];
  trustedRegistry: boolean;
  /** Lower is safer. Weighted by pin risk × exposure (pods). */
  risk: number;
}

export interface SupplyChainSummary {
  total: number;
  pinnedDigest: number;
  mutableOrFloating: number;
  untrustedRegistry: number;
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
}

const PIN_RISK: Record<PinStatus, number> = {
  "pinned-digest": 0,
  tagged: 1,
  "mutable-tag": 4,
  "floating-latest": 6,
  "no-tag": 6,
};

/** Classify an image reference's pin status and registry server. */
export function classifyImageRef(image: string): { pinStatus: PinStatus; registryServer: string } {
  const ref = image.trim();
  const registryServer = registryOf(ref);

  if (ref.includes("@sha256:")) return { pinStatus: "pinned-digest", registryServer };

  // The tag is the `:tag` of the FINAL path segment (avoids matching a registry port).
  const lastSegment = ref.split("/").pop() ?? ref;
  const colon = lastSegment.lastIndexOf(":");
  if (colon === -1) return { pinStatus: "no-tag", registryServer };

  const tag = lastSegment.slice(colon + 1).toLowerCase();
  if (!tag) return { pinStatus: "no-tag", registryServer };
  if (tag === "latest") return { pinStatus: "floating-latest", registryServer };
  if (MUTABLE_TAGS.includes(tag)) return { pinStatus: "mutable-tag", registryServer };
  return { pinStatus: "tagged", registryServer };
}

function registryOf(image: string): string {
  if (!image.includes("/")) return "docker.io";
  const first = image.split("/")[0];
  if (first.includes(".") || first.includes(":")) return first;
  return "docker.io";
}

function isTrustedRegistry(registry: string): boolean {
  return TRUSTED_REGISTRY_MARKERS.some((marker) => registry.includes(marker));
}

function gradeFromScore(score: number): SupplyChainSummary["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

/** Assess every running image, returning per-image findings (worst first) + a summary grade. */
export function assessSupplyChain(running: RunningImage[]): { findings: SupplyChainFinding[]; summary: SupplyChainSummary } {
  const findings = running
    .map((img): SupplyChainFinding => {
      const { pinStatus } = classifyImageRef(img.image);
      const trustedRegistry = isTrustedRegistry(img.registry);
      const risk = PIN_RISK[pinStatus] * Math.max(1, img.pods) + (trustedRegistry ? 0 : 2);
      return { image: img.image, registry: img.registry, pinStatus, pods: img.pods, namespaces: img.namespaces, trustedRegistry, risk };
    })
    .sort((a, b) => b.risk - a.risk);

  const summary = findings.reduce(
    (acc, f) => {
      acc.total += 1;
      if (f.pinStatus === "pinned-digest") acc.pinnedDigest += 1;
      if (f.pinStatus === "mutable-tag" || f.pinStatus === "floating-latest" || f.pinStatus === "no-tag") acc.mutableOrFloating += 1;
      if (!f.trustedRegistry) acc.untrustedRegistry += 1;
      return acc;
    },
    { total: 0, pinnedDigest: 0, mutableOrFloating: 0, untrustedRegistry: 0, grade: "A" as SupplyChainSummary["grade"], score: 100 },
  );

  // Score: start at 100, penalize each mutable/floating and untrusted-registry image.
  const penalty = summary.total > 0 ? Math.round(((summary.mutableOrFloating * 6 + summary.untrustedRegistry * 3) / summary.total)) : 0;
  summary.score = Math.max(0, 100 - penalty * 5);
  summary.grade = gradeFromScore(summary.score);
  return { findings, summary };
}
