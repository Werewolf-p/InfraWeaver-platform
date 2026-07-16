import { describe, expect, it } from "@jest/globals";
import { assessSupplyChain, classifyImageRef, type RunningImage } from "@/lib/images/supply-chain";
import { assessScanCoverage, buildImageMatrix, imageRiskScore, normalizeImageRef, rollupImageVulns, SCAN_STALE_HOURS, type ImageVulnReport } from "@/lib/images/vuln-rollup";

describe("classifyImageRef", () => {
  it("recognizes a digest pin as safest", () => {
    expect(classifyImageRef("ghcr.io/org/app@sha256:abcd").pinStatus).toBe("pinned-digest");
  });
  it("flags :latest as floating", () => {
    expect(classifyImageRef("nginx:latest").pinStatus).toBe("floating-latest");
  });
  it("flags known mutable tags", () => {
    expect(classifyImageRef("myrepo/app:main").pinStatus).toBe("mutable-tag");
  });
  it("treats a version tag as tagged (not mutable)", () => {
    expect(classifyImageRef("prom/prometheus:v2.46.0").pinStatus).toBe("tagged");
  });
  it("flags a missing tag, ignoring registry ports", () => {
    expect(classifyImageRef("registry.local:5000/app").pinStatus).toBe("no-tag");
    expect(classifyImageRef("registry.local:5000/app").registryServer).toBe("registry.local:5000");
  });
});

describe("assessSupplyChain", () => {
  it("summarizes pin posture and grades it, worst-risk first", () => {
    const running: RunningImage[] = [
      { image: "ghcr.io/org/app@sha256:deadbeef", registry: "ghcr.io", pods: 1, namespaces: ["a"] },
      { image: "nginx:latest", registry: "docker.io", pods: 5, namespaces: ["b"] },
    ];
    const { findings, summary } = assessSupplyChain(running);
    expect(summary.pinnedDigest).toBe(1);
    expect(summary.mutableOrFloating).toBe(1);
    expect(summary.untrustedRegistry).toBe(1); // docker.io
    expect(findings[0].image).toBe("nginx:latest"); // higher risk (floating + replicas + untrusted)
    expect(["A", "B", "C", "D", "F"]).toContain(summary.grade);
  });
});

describe("vuln-rollup", () => {
  const running: RunningImage[] = [
    { image: "docker.io/library/nginx:1.25", registry: "docker.io", pods: 3, namespaces: ["a"] },
    { image: "ghcr.io/org/app:v1", registry: "ghcr.io", pods: 1, namespaces: ["b"] },
  ];
  const reports: ImageVulnReport[] = [
    { image: "nginx:1.25", counts: { critical: 2, high: 1, medium: 0, low: 0, unknown: 0 }, updatedAt: "2026-07-16T00:00:00Z" },
  ];

  it("normalizes registry aliases for the join", () => {
    expect(normalizeImageRef("docker.io/library/nginx:1.25")).toBe("nginx:1.25");
  });

  it("joins reports to running images and flags unscanned", () => {
    const matrix = buildImageMatrix(running, reports);
    const nginx = matrix.find((r) => r.image.includes("nginx"));
    const app = matrix.find((r) => r.image.includes("app"));
    expect(nginx?.scanned).toBe(true);
    expect(nginx?.counts.critical).toBe(2);
    expect(app?.scanned).toBe(false);
  });

  it("weights risk by severity × replicas and rolls up coverage", () => {
    expect(imageRiskScore({ critical: 1, high: 0, medium: 0, low: 0, unknown: 0 }, 3)).toBe(300);
    const rollup = rollupImageVulns(buildImageMatrix(running, reports));
    expect(rollup.totals.critical).toBe(2);
    expect(rollup.scanned).toBe(1);
    expect(rollup.unscanned).toBe(1);
    expect(rollup.coveragePct).toBe(50);
  });

  it("flags unscanned and stale scans as blind spots", () => {
    const now = 1_800_000_000_000;
    const staleReport: ImageVulnReport = { image: "nginx:1.25", counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, updatedAt: new Date(now - (SCAN_STALE_HOURS + 1) * 3_600_000).toISOString() };
    const coverage = assessScanCoverage(buildImageMatrix(running, [staleReport]), now);
    expect(coverage.unscanned).toHaveLength(1); // ghcr app has no report
    expect(coverage.staleScans).toHaveLength(1); // nginx report is stale
    expect(coverage.coveragePct).toBe(50);
  });
});
