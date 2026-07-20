/** @jest-environment node */
// Sweep-side panel capture core: the bounded-concurrency + degenerate-rejection
// logic that stops a slow pod's empty exec from overwriting a good snapshot with
// all-zeros. The durable writer is mocked so the pure logic is exercised without a
// cluster; the panel fetcher is injected so no wp-cli/probe machinery is loaded.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/manage/panel-snapshot", () => ({
  writeSitePanelSnapshots: jest.fn(),
}));

import { runPanelCapture, isDegenerateCapture } from "@/addons/wordpress-manager/lib/manage/panel-capture";
import { writeSitePanelSnapshots } from "@/addons/wordpress-manager/lib/manage/panel-snapshot";
import type { ManagePanelId } from "@/addons/wordpress-manager/lib/manage/capabilities";

const writeMock = writeSitePanelSnapshots as jest.MockedFunction<typeof writeSitePanelSnapshots>;

/** The two plugin-count fields the original cross-check read. */
const overview = { totalPlugins: 12, activePlugins: 10 } as const;

/**
 * The FULL authoritative cross-signal a real overview carries — mirrors the
 * confirmed bug site (zonnevaarwater): a big site whose light overview reads real
 * numbers while its heavy per-panel execs flake to empty under sweep concurrency.
 */
const fullOverview = {
  totalPlugins: 12,
  activePlugins: 10,
  uploadsMb: 1077,
  dbSizeMb: 46,
  userCount: 4,
} as const;

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  writeMock.mockResolvedValue(undefined);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warnSpy?.mockRestore());

describe("isDegenerateCapture", () => {
  test("inventory with 0 plugins while the overview counts 12 → degenerate", () => {
    expect(
      isDegenerateCapture("inventory", { plugins: [], activePlugins: 0 }, overview),
    ).toBe(true);
  });

  test("inventory with plugins present → not degenerate", () => {
    expect(
      isDegenerateCapture("inventory", { plugins: [{ slug: "a" }], activePlugins: 1 }, overview),
    ).toBe(false);
  });

  test("inventory with 0 active while the overview counts active plugins → degenerate", () => {
    expect(
      isDegenerateCapture("inventory", { plugins: [{ slug: "a" }], activePlugins: 0 }, { totalPlugins: 1, activePlugins: 1 }),
    ).toBe(true);
  });

  test("updates reading 0 installed plugins while the overview counts some → degenerate", () => {
    expect(isDegenerateCapture("updates", { totalPlugins: 0, components: [] }, overview)).toBe(true);
  });

  test("no overview cross-signal → never degenerate (nothing to contradict it)", () => {
    expect(isDegenerateCapture("inventory", { plugins: [] }, undefined)).toBe(false);
  });

  test("people empty while an older overview lacks userCount → not rejected (no signal)", () => {
    // Backward-compat: an overview snapshot written before userCount existed carries
    // no people signal, so an empty capture there stays accepted.
    expect(isDegenerateCapture("people", { users: [], total: 0 }, overview)).toBe(false);
  });

  // --- The zonnevaarwater bug: media/database/users read all-zero on a big/slow
  // --- site while the overview proves the site is non-empty. These MUST be rejected.
  test("media 0 MB / 0 attachments while the overview measured 1077 MB uploads → degenerate", () => {
    expect(
      isDegenerateCapture("media", { total: 0, uploadsMb: null, mime: [], largestDirs: [] }, fullOverview),
    ).toBe(true);
  });

  test("media with real attachments → not degenerate", () => {
    expect(
      isDegenerateCapture("media", { total: 812, uploadsMb: 1077, mime: [], largestDirs: [] }, fullOverview),
    ).toBe(false);
  });

  test("database 0 MB / 0 tables while the overview measured a 46 MB database → degenerate", () => {
    expect(
      isDegenerateCapture("data", { totalMb: null, tables: [], autoloadKb: null, autoloadCount: 0, transients: 0, revisions: 0 }, fullOverview),
    ).toBe(true);
  });

  test("database with tables present → not degenerate", () => {
    expect(
      isDegenerateCapture("data", { totalMb: 46, tables: [{ name: "wp_options", sizeMb: 12 }], autoloadKb: 100, autoloadCount: 200, transients: 5, revisions: 9 }, fullOverview),
    ).toBe(false);
  });

  test("users empty while the overview counted 4 accounts → degenerate", () => {
    expect(isDegenerateCapture("people", { users: [], total: 0, roleCounts: [], limit: 100 }, fullOverview)).toBe(true);
  });

  test("users present → not degenerate", () => {
    expect(
      isDegenerateCapture("people", { users: [{ id: 1 }], total: 4, roleCounts: [], limit: 100 }, fullOverview),
    ).toBe(false);
  });

  test("a genuinely empty site (overview measured 0 uploads/db) → empty capture accepted", () => {
    const emptySite = { totalPlugins: 0, activePlugins: 0, uploadsMb: 0, dbSizeMb: 0, userCount: 1 } as const;
    expect(
      isDegenerateCapture("media", { total: 0, uploadsMb: null, mime: [], largestDirs: [] }, emptySite),
    ).toBe(false);
    expect(
      isDegenerateCapture("data", { totalMb: null, tables: [], autoloadKb: null, autoloadCount: 0, transients: 0, revisions: 0 }, emptySite),
    ).toBe(false);
  });
});

describe("runPanelCapture", () => {
  const ids = (arr: string[]): ManagePanelId[] => arr as ManagePanelId[];

  test("rejects a degenerate inventory and keeps the other panel — never blanks a good snapshot", async () => {
    const fetchPanel = jest.fn(async (_site: string, panelId: ManagePanelId) =>
      panelId === "inventory"
        ? { plugins: [], themes: [], activePlugins: 0, pluginUpdates: 0, themeUpdates: 0 }
        : { users: [{ id: 1 }], total: 1 },
    );

    const result = await runPanelCapture(fetchPanel, "slow-site", ids(["inventory", "people"]), overview);

    // inventory is a demonstrably-wrong empty capture → counted failed, NOT stored.
    expect(result).toEqual({ captured: 1, failed: 1 });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe("slow-site");
    expect(writeMock.mock.calls[0][1].map((e) => e.panel)).toEqual(["people"]);
  });

  test("stores a legitimately-empty panel that has no contradicting overview signal", async () => {
    const fetchPanel = jest.fn(async () => ({ users: [], total: 0 }));

    const result = await runPanelCapture(fetchPanel, "empty-site", ids(["people"]), overview);

    expect(result).toEqual({ captured: 1, failed: 0 });
    expect(writeMock.mock.calls[0][1].map((e) => e.panel)).toEqual(["people"]);
  });

  test("a thrown probe is isolated — the rest still capture", async () => {
    const fetchPanel = jest.fn(async (_site: string, panelId: ManagePanelId) => {
      if (panelId === "content") throw new Error("exec timed out");
      return { ok: true };
    });

    const result = await runPanelCapture(fetchPanel, "site", ids(["updates", "content", "media"]));

    expect(result).toEqual({ captured: 2, failed: 1 });
    expect(writeMock.mock.calls[0][1].map((e) => e.panel).sort()).toEqual(["media", "updates"]);
  });

  test("an empty panel list is a no-op (no write)", async () => {
    const fetchPanel = jest.fn();
    const result = await runPanelCapture(fetchPanel, "site", []);
    expect(result).toEqual({ captured: 0, failed: 0 });
    expect(fetchPanel).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("bounds concurrency at the pool width yet still captures every healthy panel", async () => {
    const panels = ids(["updates", "content", "media", "people", "data", "health"]);
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const fetchPanel = jest.fn(async (_site: string, panelId: ManagePanelId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { id: panelId };
    });

    const promise = runPanelCapture(fetchPanel, "blog", panels);

    // Release one parked capture per iteration; each freed lane enqueues the next.
    for (let released = 0; released < panels.length; released += 1) {
      let guard = 0;
      while (gates.length === 0) {
        if (guard++ > 1000) throw new Error("capture stalled — no fetch in flight to release");
        await Promise.resolve();
      }
      gates.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    const result = await promise;
    expect(result).toEqual({ captured: 6, failed: 0 });
    expect(peak).toBeLessThanOrEqual(3); // PANEL_CAPTURE_CONCURRENCY
    expect(peak).toBeGreaterThan(1); // ...but not serialised
    expect(writeMock.mock.calls[0][1].map((e) => e.panel).sort()).toEqual(
      [...panels].sort(),
    );
  });
});
