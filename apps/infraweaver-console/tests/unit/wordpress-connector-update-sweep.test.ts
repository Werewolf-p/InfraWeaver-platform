/** @jest-environment node */
// Fleet-wide Connector update sweep (§5.1 maintenance). The contract mirrors the
// health sweep: MANAGED links only, pending links skipped, every site isolated so
// one broken pod never aborts the batch, and the summary tallies updated/failed
// against the bundled target version.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  updateConnectorPlugin: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/connector-package", () => ({
  buildConnectorPackage: jest.fn(),
}));

import { runConnectorUpdateSweep } from "@/addons/wordpress-manager/lib/update-sweep";
import { listExternalSites, type ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";
import { updateConnectorPlugin } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";
import { buildConnectorPackage } from "@/addons/wordpress-manager/lib/connector-package";

const listMock = listExternalSites as jest.MockedFunction<typeof listExternalSites>;
const updateMock = updateConnectorPlugin as jest.MockedFunction<typeof updateConnectorPlugin>;
const pkgMock = buildConnectorPackage as jest.MockedFunction<typeof buildConnectorPackage>;

/** Minimal managed-link record — only the fields the sweep filters on matter. */
function link(overrides: Partial<ExternalSiteRecord>): ExternalSiteRecord {
  return {
    siteId: "id",
    name: "n",
    url: "https://x",
    state: "active",
    fingerprintConfirmed: true,
    createdAt: "",
    createdBy: "",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
    managed: true,
    siteName: "site",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pkgMock.mockResolvedValue({ zip: Buffer.from(""), version: "1.4.0", filename: "x.zip" });
  updateMock.mockResolvedValue({ version: "1.4.0" });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  warnSpy = warn;
});

let warnSpy: jest.SpyInstance;
afterEach(() => warnSpy?.mockRestore());

describe("runConnectorUpdateSweep", () => {
  test("updates only enrolled MANAGED links — external and pending are skipped", async () => {
    listMock.mockResolvedValue([
      link({ siteName: "managed-active", state: "active" }),
      link({ siteName: "managed-quarantined", state: "quarantined" }),
      link({ siteName: "managed-pending", state: "pending" }), // not enrolled yet
      link({ siteName: "external", managed: false }), // no exec channel
      link({ siteName: undefined }), // managed but unnamed — nothing to target
    ]);

    const summary = await runConnectorUpdateSweep();

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledWith("managed-active");
    expect(updateMock).toHaveBeenCalledWith("managed-quarantined");
    expect(updateMock).not.toHaveBeenCalledWith("managed-pending");
    expect(updateMock).not.toHaveBeenCalledWith("external");
    expect(summary.total).toBe(2);
    expect(summary.updated).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.deferred).toBe(0); // fleet under the cap — nothing left over
    expect(summary.targetVersion).toBe("1.4.0");
  });

  test("isolates a per-site failure — the rest still update (allSettled)", async () => {
    listMock.mockResolvedValue([
      link({ siteName: "ok-1" }),
      link({ siteName: "broken" }),
      link({ siteName: "ok-2" }),
    ]);
    updateMock.mockImplementation(async (site: string) => {
      if (site === "broken") throw new Error("pod not running");
      return { version: "1.4.0" };
    });

    const summary = await runConnectorUpdateSweep();

    expect(summary.total).toBe(3);
    expect(summary.updated).toBe(2);
    expect(summary.failed).toBe(1);
    const broken = summary.results.find((r) => r.site === "broken");
    expect(broken).toEqual({ site: "broken", ok: false, reason: "pod not running" });
  });

  test("carries the read-back version and null when the link is not commandable", async () => {
    listMock.mockResolvedValue([link({ siteName: "quarantined", state: "quarantined" })]);
    updateMock.mockResolvedValue({ version: null }); // reinstall done, no signed round-trip

    const summary = await runConnectorUpdateSweep();

    expect(summary.results[0]).toEqual({ site: "quarantined", ok: true, version: null });
  });

  test("no enrolled managed links → an empty, zeroed summary", async () => {
    listMock.mockResolvedValue([link({ managed: false }), link({ state: "pending" })]);

    const summary = await runConnectorUpdateSweep();

    expect(updateMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ total: 0, updated: 0, failed: 0, deferred: 0, targetVersion: "1.4.0" });
    expect(summary.results).toEqual([]);
  });

  test("caps a run at maxPerRun and defers the rest (blast radius)", async () => {
    listMock.mockResolvedValue([
      link({ siteName: "a" }),
      link({ siteName: "b" }),
      link({ siteName: "c" }),
      link({ siteName: "d" }),
      link({ siteName: "e" }),
    ]);

    const summary = await runConnectorUpdateSweep({ maxPerRun: 2 });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(2); // only the attempted count, not the fleet size
    expect(summary.updated).toBe(2);
    expect(summary.deferred).toBe(3); // 5 enrolled − 2 attempted
    expect(summary.results).toHaveLength(2);
  });

  test("deferred counts only ENROLLED links — pending/external never inflate it", async () => {
    listMock.mockResolvedValue([
      link({ siteName: "a" }),
      link({ siteName: "b" }),
      link({ siteName: "c" }),
      link({ siteName: "pending", state: "pending" }), // not enrolled — never a target
      link({ siteName: "external", managed: false }), // no exec channel — never a target
    ]);

    const summary = await runConnectorUpdateSweep({ maxPerRun: 2 });

    expect(summary.total).toBe(2);
    expect(summary.deferred).toBe(1); // 3 enrolled − 2 attempted; pending/external excluded
  });

  test("bounds concurrency — the CM write burst never exceeds the pool width", async () => {
    // The 409 race is a lockstep write burst on the one IWSL ConfigMap. Prove the
    // sweep never runs more than its pool width of per-site updates at once, no
    // matter how large the fleet. Each update parks on a gate we release one at a
    // time, so the peak in-flight count is observable.
    const links = Array.from({ length: 12 }, (_, i) => link({ siteName: `s${i}` }));
    listMock.mockResolvedValue(links);

    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    updateMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { version: "1.4.0" };
    });

    const summaryPromise = runConnectorUpdateSweep();

    // Release exactly one parked update per iteration; after each release the
    // freed lane enqueues the next site, so draining all 12 completes the sweep.
    for (let released = 0; released < links.length; released += 1) {
      let guard = 0;
      while (gates.length === 0) {
        if (guard++ > 1000) throw new Error("sweep stalled — no update in flight to release");
        await Promise.resolve();
      }
      gates.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    const summary = await summaryPromise;
    expect(summary.updated).toBe(12);
    expect(peak).toBeLessThanOrEqual(4); // SWEEP_CONCURRENCY
    expect(peak).toBeGreaterThan(1); // ...but not serialised
  });
});
