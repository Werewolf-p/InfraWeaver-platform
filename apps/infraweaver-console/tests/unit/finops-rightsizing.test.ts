import { describe, expect, it } from "@jest/globals";
import {
  assessContainer,
  assessContainers,
  HEADROOM_FACTOR,
  MIN_CPU_M,
  type ContainerUsage,
} from "@/lib/finops/rightsizing";

function usage(over: Partial<ContainerUsage>): ContainerUsage {
  return {
    namespace: "ns",
    pod: "pod",
    container: "app",
    requestCpuM: 0,
    usageCpuM: 0,
    requestMemMi: 0,
    usageMemMi: 0,
    hasMetrics: true,
    ...over,
  };
}

describe("assessContainer", () => {
  it("flags a container using far below its request as over-provisioned with a dollar figure", () => {
    // Arrange: 1000m requested, 100m used (10%) → over-provisioned.
    const rec = assessContainer(usage({ requestCpuM: 1000, usageCpuM: 100, requestMemMi: 1024, usageMemMi: 128 }));

    // Act + Assert
    expect(rec.status).toBe("over");
    expect(rec.recommendedCpuM).toBe(Math.round(100 * HEADROOM_FACTOR));
    expect(rec.monthlyWasteUsd).toBeGreaterThan(0);
  });

  it("flags a container using above its request as under-provisioned with zero waste", () => {
    const rec = assessContainer(usage({ requestCpuM: 100, usageCpuM: 200, requestMemMi: 128, usageMemMi: 256 }));
    expect(rec.status).toBe("under");
    expect(rec.monthlyWasteUsd).toBe(0);
    expect(rec.recommendedCpuM).toBeGreaterThanOrEqual(100);
  });

  it("treats a container with no metrics as no-metrics and never recommends a change", () => {
    const rec = assessContainer(usage({ requestCpuM: 500, requestMemMi: 512, hasMetrics: false }));
    expect(rec.status).toBe("no-metrics");
    expect(rec.recommendedCpuM).toBe(500);
    expect(rec.monthlyWasteUsd).toBe(0);
  });

  it("treats usage with no declared request as under-provisioned (request should be set)", () => {
    const rec = assessContainer(usage({ requestCpuM: 0, usageCpuM: 50, requestMemMi: 0, usageMemMi: 64 }));
    expect(rec.status).toBe("under");
  });

  it("never recommends a CPU request below the floor", () => {
    const rec = assessContainer(usage({ requestCpuM: 1000, usageCpuM: 1, requestMemMi: 512, usageMemMi: 8 }));
    expect(rec.recommendedCpuM).toBeGreaterThanOrEqual(MIN_CPU_M);
  });
});

describe("assessContainers", () => {
  it("rolls up counts and total waste, sorting biggest waste first", () => {
    const { recommendations, summary } = assessContainers([
      usage({ pod: "a", requestCpuM: 100, usageCpuM: 60, requestMemMi: 100, usageMemMi: 60 }), // optimal (0.6 util)
      usage({ pod: "b", requestCpuM: 2000, usageCpuM: 50, requestMemMi: 2048, usageMemMi: 64 }), // big over
      usage({ pod: "c", requestCpuM: 100, usageCpuM: 300, requestMemMi: 128, usageMemMi: 400 }), // under
    ]);

    expect(summary.analyzed).toBe(3);
    expect(summary.overCount).toBe(1);
    expect(summary.underCount).toBe(1);
    expect(summary.optimalCount).toBe(1);
    expect(summary.totalMonthlyWasteUsd).toBeGreaterThan(0);
    expect(recommendations[0].pod).toBe("b"); // biggest waste first
  });
});
