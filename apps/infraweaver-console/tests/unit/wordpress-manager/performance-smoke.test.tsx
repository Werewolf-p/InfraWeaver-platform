/**
 * Compile-smoke: importing every new Performance module forces ts-jest to
 * type-check the whole component tree (the .tsx zones are otherwise not exercised
 * by a unit test). A type error anywhere in the surface fails this suite.
 */
import { PerformancePanel } from "@/addons/wordpress-manager/components/manage/performance/performance-panel";
import { PageCacheControls, parseExclusions } from "@/addons/wordpress-manager/components/manage/performance/perf-cache-controls";
import { SpeedPackControls, LazyLoadControls } from "@/addons/wordpress-manager/components/manage/performance/perf-optimizations";
import { PerfAuditTable } from "@/addons/wordpress-manager/components/manage/performance/perf-audit-table";
import { Toggle } from "@/addons/wordpress-manager/components/manage/performance/perf-toggle";
import * as usePerf from "@/addons/wordpress-manager/lib/manage/use-performance";

describe("performance surface compiles + exports", () => {
  test("every zone + hook is a callable export", () => {
    for (const fn of [PerformancePanel, PageCacheControls, SpeedPackControls, LazyLoadControls, PerfAuditTable, Toggle]) {
      expect(typeof fn).toBe("function");
    }
    for (const name of ["usePerfStatus", "usePerfAudit", "purgeCache", "warmCache", "configureCache", "setPerfSettings"] as const) {
      expect(typeof (usePerf as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("parseExclusions trims, drops blanks, keeps order", () => {
    expect(parseExclusions("/checkout\n\n  /members/*  \n")).toEqual(["/checkout", "/members/*"]);
  });
});
