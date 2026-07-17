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
    expect(summary).toMatchObject({ total: 0, updated: 0, failed: 0, targetVersion: "1.4.0" });
    expect(summary.results).toEqual([]);
  });
});
