/** @jest-environment node */
// Fleet aggregation: rolls up provisioned sites + signed Connector links + in-pod
// wp-cli overviews into a real fleet summary. Verifies status derivation, offline
// handling (unreadable pod / failed overview), summary math, and worst-first sort.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ listSites: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-enrollment", () => ({ listExternalSiteViews: jest.fn() }));
// The rollup now reads through loadManageOverview (durable snapshot + SWR), not a
// raw uncached getManageOverview — so mock the cached loader, which returns a
// Cached<ManageOverview> ({ value, cachedAt, stale }).
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ loadManageOverview: jest.fn() }));

import { aggregateFleet } from "@/addons/wordpress-manager/lib/fleet/aggregate";
import { listSites } from "@/addons/wordpress-manager/lib/provision";
import { listExternalSiteViews } from "@/addons/wordpress-manager/lib/iwsl-enrollment";
import { loadManageOverview } from "@/addons/wordpress-manager/lib/manage/overview";

const sitesMock = listSites as jest.Mock;
const linksMock = listExternalSiteViews as jest.Mock;
const overviewMock = loadManageOverview as jest.Mock;

function site(name: string, ready = true) {
  return { site: name, host: `${name}.example`, ready, replicas: 1 };
}
function link(siteName: string, over: Record<string, unknown> = {}) {
  return {
    siteName,
    managed: true,
    state: "active",
    fingerprintConfirmed: true,
    connectorVersion: "0.4.2",
    rejections: 0,
    lastHealth: { at: "2026-07-19T00:00:00.000Z", ok: true, roundtripMs: 2663 },
    ...over,
  };
}
// Returns a Cached<ManageOverview> wrapper — the shape loadManageOverview resolves
// to — so aggregate's `.value` extraction is exercised exactly as in production.
function overview(over: Record<string, unknown> = {}) {
  return {
    value: {
      wpVersion: "6.5",
      phpVersion: "8.3",
      coreUpdate: false,
      pendingUpdates: 0,
      pluginUpdates: 0,
      themeUpdates: 0,
      activePlugins: 5,
      dbSizeMb: 40,
      health: 95,
      connector: { active: true, lastRoundtripMs: 2663, lastCheckIso: null, connectorVersion: "0.4.2" },
      ...over,
    },
    cachedAt: Date.now(),
    stale: false,
  };
}

beforeEach(() => jest.clearAllMocks());

test("derives status from real health/updates and rolls up the summary", async () => {
  sitesMock.mockResolvedValue([site("healthy-one"), site("needs-attention"), site("crit")]);
  linksMock.mockResolvedValue([link("healthy-one"), link("needs-attention", { rejections: 2 }), link("crit")]);
  overviewMock.mockImplementation(async (s: string) => {
    if (s === "healthy-one") return overview({ health: 96 });
    if (s === "needs-attention") return overview({ health: 88, pluginUpdates: 3, coreUpdate: true });
    return overview({ health: 40 }); // crit
  });

  const data = await aggregateFleet();

  const byId = new Map(data.sites.map((r) => [r.id, r]));
  expect(byId.get("healthy-one")?.status).toBe("healthy");
  expect(byId.get("needs-attention")?.status).toBe("attention");
  expect(byId.get("crit")?.status).toBe("critical");
  expect(byId.get("needs-attention")?.updates).toEqual({ core: 1, plugins: 3, themes: 0 });
  expect(byId.get("needs-attention")?.rejections).toBe(2);

  expect(data.summary).toMatchObject({ total: 3, healthy: 1, attention: 1, critical: 1, offline: 0, connected: 3 });
  expect(data.summary.updatesPending).toBe(4); // 0 + (1 core + 3 plugin) + 0
  expect(data.summary.avgResponse).toBe(2663);
});

test("a site whose overview read fails is offline (never blanks the fleet)", async () => {
  sitesMock.mockResolvedValue([site("ok"), site("down")]);
  linksMock.mockResolvedValue([link("ok"), link("down")]);
  overviewMock.mockImplementation(async (s: string) => {
    if (s === "down") throw new Error("pod exec failed");
    return overview({ health: 90 });
  });

  const data = await aggregateFleet();
  const down = data.sites.find((r) => r.id === "down");
  expect(down?.status).toBe("offline");
  expect(down?.offline).toBe(true);
  expect(down?.health).toBeNull();
  expect(data.summary).toMatchObject({ total: 2, offline: 1 });
});

test("a not-ready pod is offline regardless of a stale overview", async () => {
  sitesMock.mockResolvedValue([site("starting", false)]);
  linksMock.mockResolvedValue([]);
  overviewMock.mockResolvedValue(overview({ health: 99 }));
  const data = await aggregateFleet();
  expect(data.sites[0].status).toBe("offline");
  expect(data.summary.connected).toBe(0);
});

test("sites are sorted worst-health first so attention rises to the top", async () => {
  sitesMock.mockResolvedValue([site("a"), site("b"), site("c")]);
  linksMock.mockResolvedValue([link("a"), link("b"), link("c")]);
  overviewMock.mockImplementation(async (s: string) =>
    overview({ health: s === "a" ? 95 : s === "b" ? 50 : 80 }),
  );
  const data = await aggregateFleet();
  expect(data.sites.map((r) => r.id)).toEqual(["b", "c", "a"]);
});

test("avgResponse is null when no link has a round-trip", async () => {
  sitesMock.mockResolvedValue([site("x")]);
  linksMock.mockResolvedValue([link("x", { lastHealth: undefined })]);
  overviewMock.mockResolvedValue(overview());
  const data = await aggregateFleet();
  expect(data.sites[0].responseMs).toBeNull();
  expect(data.summary.avgResponse).toBeNull();
});

test("bounds overview fan-out so one open tab cannot stampede every pod", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `s${i}`);
  sitesMock.mockResolvedValue(names.map((n) => site(n)));
  linksMock.mockResolvedValue(names.map((n) => link(n)));

  let inFlight = 0;
  let peak = 0;
  overviewMock.mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Defer a macrotask so all admitted lanes overlap before any resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    return overview();
  });

  const data = await aggregateFleet();

  expect(data.sites).toHaveLength(12);
  // Bounded at FLEET_ROLLUP_CONCURRENCY (3) — never all 12 at once.
  expect(peak).toBeLessThanOrEqual(3);
  expect(overviewMock).toHaveBeenCalledTimes(12);
});
