/** @jest-environment node */
// Server-driven connector health sweep (§12.5). Both link families are swept in
// one batch: §5.1 MANAGED links over k8s-exec (connectorHealthCheck) and §5
// EXTERNAL links over the public HTTPS channel (externalConnectorHealthCheck).
// Only active + fingerprint-confirmed links are targeted, each site is isolated
// under allSettled so one dead endpoint never aborts the rest, and the summary
// tallies passed/failed plus a per-transport breakdown.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  connectorHealthCheck: jest.fn(),
  externalConnectorHealthCheck: jest.fn(),
}));

import { runHealthSweep } from "@/addons/wordpress-manager/lib/health-sweep";
import { listExternalSites, type ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";
import {
  connectorHealthCheck,
  externalConnectorHealthCheck,
  type ConnectorHealth,
} from "@/addons/wordpress-manager/lib/iwsl-managed-ops";

const listMock = listExternalSites as jest.MockedFunction<typeof listExternalSites>;
const execMock = connectorHealthCheck as jest.MockedFunction<typeof connectorHealthCheck>;
const httpsMock = externalConnectorHealthCheck as jest.MockedFunction<typeof externalConnectorHealthCheck>;

/** Minimal link record — only the fields the sweep filters on matter. */
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
    ...overrides,
  };
}

/** Minimal ConnectorHealth reply. */
function health(overrides: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return { ok: true, roundtripMs: 12, result: {}, ...overrides };
}

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  execMock.mockResolvedValue(health());
  httpsMock.mockResolvedValue(health());
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warnSpy?.mockRestore());

describe("runHealthSweep", () => {
  test("sweeps BOTH transports — managed over exec, external over HTTPS", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "m1", managed: true, siteName: "managed-one" }),
      link({ siteId: "ext-1", managed: false }),
    ]);

    const summary = await runHealthSweep();

    // Managed link goes through the exec path, keyed by siteName…
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith("managed-one");
    // …external link goes through the HTTPS path, keyed by siteId.
    expect(httpsMock).toHaveBeenCalledTimes(1);
    expect(httpsMock).toHaveBeenCalledWith("ext-1");

    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0, managedTotal: 1, externalTotal: 1 });
    const managed = summary.results.find((r) => r.site === "managed-one");
    const external = summary.results.find((r) => r.site === "ext-1");
    expect(managed).toMatchObject({ transport: "exec", ok: true, roundtripMs: 12 });
    expect(external).toMatchObject({ transport: "https", ok: true, roundtripMs: 12 });
  });

  test("one dead external endpoint does not abort the batch (allSettled isolation)", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "m1", managed: true, siteName: "managed-one" }),
      link({ siteId: "ext-dead", managed: false }),
      link({ siteId: "ext-ok", managed: false }),
    ]);
    httpsMock.mockImplementation(async (siteId: string) => {
      if (siteId === "ext-dead") throw new Error("fetch failed: ECONNREFUSED");
      return health();
    });

    const summary = await runHealthSweep();

    // The managed exec check and the healthy external check both still ran.
    expect(execMock).toHaveBeenCalledWith("managed-one");
    expect(httpsMock).toHaveBeenCalledWith("ext-ok");
    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1, managedTotal: 1, externalTotal: 2 });
    const dead = summary.results.find((r) => r.site === "ext-dead");
    // A transport fault is re-confirmed before the link is reported down.
    expect(dead).toEqual({
      site: "ext-dead",
      transport: "https",
      ok: false,
      reason: "fetch failed: ECONNREFUSED",
      attempts: 2,
    });
  });

  test("only active + fingerprint-confirmed links are swept — others skipped on both families", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "m-ok", managed: true, siteName: "m-ok" }),
      link({ siteId: "m-pending", managed: true, siteName: "m-pending", state: "pending" }),
      link({ siteId: "m-unconfirmed", managed: true, siteName: "m-unconfirmed", fingerprintConfirmed: false }),
      link({ siteId: "m-noname", managed: true, siteName: undefined }),
      link({ siteId: "e-ok", managed: false }),
      link({ siteId: "e-quarantined", managed: false, state: "quarantined" }),
      link({ siteId: "e-unconfirmed", managed: false, fingerprintConfirmed: false }),
    ]);

    const summary = await runHealthSweep();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith("m-ok");
    expect(httpsMock).toHaveBeenCalledTimes(1);
    expect(httpsMock).toHaveBeenCalledWith("e-ok");
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0, managedTotal: 1, externalTotal: 1 });
  });

  test("carries a signed rejectedReason through without throwing", async () => {
    listMock.mockResolvedValue([link({ siteId: "ext-1", managed: false })]);
    httpsMock.mockResolvedValue(health({ ok: false, rejectedReason: "epoch-too-low" }));

    const summary = await runHealthSweep();

    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1, externalTotal: 1 });
    expect(summary.results[0]).toMatchObject({ site: "ext-1", transport: "https", ok: false, reason: "epoch-too-low" });
    // A deterministic plugin verdict is NOT re-checked — one call, attempts=1.
    expect(httpsMock).toHaveBeenCalledTimes(1);
    expect(summary.results[0].attempts).toBe(1);
  });

  test("down-confirmation: a transient transport blip that clears on re-check is not flapped down", async () => {
    listMock.mockResolvedValue([link({ siteId: "ext-flap", managed: false })]);
    // First attempt throws (momentary 502/reset), second attempt succeeds.
    httpsMock
      .mockRejectedValueOnce(new Error("fetch failed: 502"))
      .mockResolvedValueOnce(health({ roundtripMs: 20 }));

    const summary = await runHealthSweep();

    expect(httpsMock).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(summary.results[0]).toMatchObject({
      site: "ext-flap",
      ok: true,
      attempts: 2,
      flapSuppressed: true,
    });
  });

  test("down-confirmation: a link down on BOTH attempts is reported down (confirmed)", async () => {
    listMock.mockResolvedValue([link({ siteId: "ext-down", managed: false })]);
    httpsMock.mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

    const summary = await runHealthSweep();

    expect(httpsMock).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(summary.results[0]).toMatchObject({ site: "ext-down", ok: false, attempts: 2 });
    expect(summary.results[0].flapSuppressed).toBeUndefined();
  });

  test("no commandable links → empty, zeroed summary", async () => {
    listMock.mockResolvedValue([
      link({ managed: true, siteName: "m", state: "pending" }),
      link({ managed: false, state: "quarantined" }),
    ]);

    const summary = await runHealthSweep();

    expect(execMock).not.toHaveBeenCalled();
    expect(httpsMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ total: 0, passed: 0, failed: 0, managedTotal: 0, externalTotal: 0 });
    expect(summary.results).toEqual([]);
  });
});
