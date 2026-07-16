import { describe, expect, it } from "@jest/globals";
import { cpuMonthlyUsd, memoryMonthlyUsd, resourceMonthlyUsd, CPU_USD_PER_VCPU_HR, HOURS_PER_MONTH } from "@/lib/finops/cost-model";
import { attributeCost } from "@/lib/finops/cost-attribution";

describe("cost-model", () => {
  it("prices one vCPU-month at the rate × hours", () => {
    expect(cpuMonthlyUsd(1000)).toBeCloseTo(CPU_USD_PER_VCPU_HR * HOURS_PER_MONTH, 6);
  });

  it("prices zero/negative resources at zero", () => {
    expect(cpuMonthlyUsd(0)).toBe(0);
    expect(memoryMonthlyUsd(-100)).toBe(0);
    expect(resourceMonthlyUsd(0, 0)).toBe(0);
  });
});

describe("attributeCost", () => {
  it("splits requested spend into used vs reclaimable, sorted by reclaimable desc", () => {
    const attribution = attributeCost(
      [
        { namespace: "idle", cpuM: 1000, memMi: 1024 },
        { namespace: "busy", cpuM: 1000, memMi: 1024 },
      ],
      [
        { namespace: "idle", cpuM: 100, memMi: 128 }, // barely used → big reclaimable
        { namespace: "busy", cpuM: 950, memMi: 1000 }, // nearly full → small reclaimable
      ],
    );

    expect(attribution.namespaces[0].namespace).toBe("idle");
    expect(attribution.namespaces[0].reclaimableUsd).toBeGreaterThan(attribution.namespaces[1].reclaimableUsd);
    expect(attribution.totals.reclaimableUsd).toBeGreaterThan(0);
  });

  it("clamps reclaimable at zero when usage bursts above requests", () => {
    const attribution = attributeCost(
      [{ namespace: "burst", cpuM: 100, memMi: 128 }],
      [{ namespace: "burst", cpuM: 500, memMi: 512 }],
    );
    expect(attribution.namespaces[0].reclaimableUsd).toBe(0);
    expect(attribution.namespaces[0].utilizationPct).toBe(100);
  });

  it("treats a namespace with no usage sample as fully reclaimable", () => {
    const attribution = attributeCost([{ namespace: "ghost", cpuM: 1000, memMi: 1024 }], []);
    expect(attribution.namespaces[0].usedUsd).toBe(0);
    expect(attribution.namespaces[0].reclaimableUsd).toBe(attribution.namespaces[0].requestedUsd);
  });
});
