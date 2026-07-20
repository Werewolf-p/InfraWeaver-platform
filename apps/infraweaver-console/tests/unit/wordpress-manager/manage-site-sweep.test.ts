/** @jest-environment node */
// Manage-snapshot sweep: the isolation + persist-only-successes logic. Collaborators
// (live overview pull, durable batch write) are mocked so sweepSites is exercised
// without a cluster. Asserts one unreachable site never blanks the batch and that
// a failed pull is NOT persisted (the site keeps its last good snapshot).
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ listSites: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ getManageOverview: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/site-snapshot", () => ({ writeSiteSnapshots: jest.fn() }));

import { sweepSites } from "@/addons/wordpress-manager/lib/manage/site-sweep";
import { getManageOverview } from "@/addons/wordpress-manager/lib/manage/overview";
import { writeSiteSnapshots } from "@/addons/wordpress-manager/lib/manage/site-snapshot";
import type { ManageOverview } from "@/addons/wordpress-manager/lib/manage/types";

const pullMock = getManageOverview as jest.MockedFunction<typeof getManageOverview>;
const writeMock = writeSiteSnapshots as jest.MockedFunction<typeof writeSiteSnapshots>;

function overview(site: string): ManageOverview {
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
  };
}

describe("sweepSites", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    writeMock.mockResolvedValue(undefined);
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
  });

  test("an all-failed sweep still resolves (empty batch write skipped)", async () => {
    pullMock.mockRejectedValue(new Error("boom"));

    const summary = await sweepSites(["x"]);

    expect(summary).toMatchObject({ total: 1, captured: 0, failed: 1 });
    // writeSiteSnapshots is called with an empty list; it no-ops internally.
    expect(writeMock).toHaveBeenCalledWith([]);
  });
});
