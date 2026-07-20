/** @jest-environment node */
// Manage-snapshot sweep: the isolation + persist-only-successes logic, now also
// covering per-panel capture. Collaborators (live overview pull, durable overview
// batch write, per-site panel capture) are mocked so sweepSites is exercised
// without a cluster. Asserts one unreachable site never blanks the batch, a failed
// pull is NOT persisted, and each captured site's AVAILABLE panels are swept with
// their counts folded back into the summary.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ listSites: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ getManageOverview: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/site-snapshot", () => ({ writeSiteSnapshots: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/panel-data", () => ({ capturePanelSnapshots: jest.fn() }));

import { sweepSites } from "@/addons/wordpress-manager/lib/manage/site-sweep";
import { getManageOverview } from "@/addons/wordpress-manager/lib/manage/overview";
import { writeSiteSnapshots } from "@/addons/wordpress-manager/lib/manage/site-snapshot";
import { capturePanelSnapshots } from "@/addons/wordpress-manager/lib/manage/panel-data";
import type { ManageOverview } from "@/addons/wordpress-manager/lib/manage/types";

const pullMock = getManageOverview as jest.MockedFunction<typeof getManageOverview>;
const writeMock = writeSiteSnapshots as jest.MockedFunction<typeof writeSiteSnapshots>;
const captureMock = capturePanelSnapshots as jest.MockedFunction<typeof capturePanelSnapshots>;

function overview(site: string, overrides: Partial<ManageOverview> = {}): ManageOverview {
  return {
    site,
    wpVersion: "6.5",
    phpVersion: "8.3",
    coreUpdate: false,
    pendingUpdates: 0,
    pluginUpdates: 0,
    themeUpdates: 0,
    activePlugins: 1,
    totalPlugins: 1,
    dbSizeMb: 1,
    uploadsMb: 1,
    cachePlugin: null,
    health: 100,
    connector: { active: false, lastRoundtripMs: null, lastCheckIso: null, connectorVersion: null },
    capabilities: {} as ManageOverview["capabilities"],
    panels: [],
    ...overrides,
  };
}

describe("sweepSites", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    writeMock.mockResolvedValue(undefined);
    captureMock.mockResolvedValue({ captured: 0, failed: 0 });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy?.mockRestore());

  test("pulls every site and batch-persists all successes", async () => {
    pullMock.mockImplementation(async (site: string) => overview(site));

    const summary = await sweepSites(["a", "b"]);

    expect(summary).toMatchObject({ total: 2, captured: 2, failed: 0 });
    expect(summary.results.every((r) => r.ok)).toBe(true);
    // One batch write carrying both sites.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0].map((e) => e.site).sort()).toEqual(["a", "b"]);
  });

  test("one failing site does not blank the batch and is not persisted", async () => {
    pullMock.mockImplementation(async (site: string) => {
      if (site === "down") throw new Error("WordPress pod is not running yet");
      return overview(site);
    });

    const summary = await sweepSites(["ok", "down"]);

    expect(summary).toMatchObject({ total: 2, captured: 1, failed: 1 });
    expect(summary.results.find((r) => r.site === "down")).toMatchObject({
      ok: false,
      reason: "WordPress pod is not running yet",
    });
    // Only the healthy site is persisted — "down" keeps its last good snapshot.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0].map((e) => e.site)).toEqual(["ok"]);
    // Panels are only captured for the site whose overview was captured.
    expect(captureMock.mock.calls.map((c) => c[0])).toEqual(["ok"]);
  });

  test("an all-failed sweep still resolves (empty batch write skipped)", async () => {
    pullMock.mockRejectedValue(new Error("boom"));

    const summary = await sweepSites(["x"]);

    expect(summary).toMatchObject({ total: 1, captured: 0, failed: 1, panelsCaptured: 0, panelsFailed: 0 });
    // writeSiteSnapshots is called with an empty list; it no-ops internally.
    expect(writeMock).toHaveBeenCalledWith([]);
    // No captured overview ⇒ no panel capture attempted.
    expect(captureMock).not.toHaveBeenCalled();
  });

  test("captures each site's AVAILABLE panels and folds counts into the summary", async () => {
    pullMock.mockImplementation(async (site: string) =>
      overview(site, {
        panels: [
          { id: "updates", available: true },
          { id: "people", available: true },
          { id: "store", available: false },
        ],
      }),
    );
    captureMock.mockResolvedValue({ captured: 2, failed: 1 });

    const summary = await sweepSites(["blog"]);

    // Only the gate-satisfied panels are handed to capture (store excluded).
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0]).toBe("blog");
    expect(captureMock.mock.calls[0][1]).toEqual(["updates", "people"]);
    // Counts fold back per-result and into the fleet totals.
    expect(summary.results[0]).toMatchObject({ site: "blog", panelsCaptured: 2, panelsFailed: 1 });
    expect(summary).toMatchObject({ panelsCaptured: 2, panelsFailed: 1 });
  });
});
