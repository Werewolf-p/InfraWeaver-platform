/** @jest-environment node */
// IWSL Connector Prometheus exporter. Two halves tested independently: the pure
// renderConnectorMetrics() exposition formatter, and collectConnectorMetrics()
// which fans a signed metrics.snapshot across every commandable link (managed
// over exec, external over HTTPS) under allSettled isolation + an SWR cache.
// Also asserts the console RPC registry stays in lockstep with the plugin's
// metrics.snapshot allow-list entry.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  connectorMetrics: jest.fn(),
  externalConnectorMetrics: jest.fn(),
}));
// Pass-through cache so the exporter's SWR layer never bleeds state across tests
// and the cache metadata (cachedAt/stale) is deterministic.
jest.mock("@/addons/wordpress-manager/lib/manage/snapshot-cache", () => ({
  withCache: jest.fn(async (_key: string, _freshMs: number, loader: () => Promise<unknown>) => ({
    value: await loader(),
    cachedAt: 1_000,
    stale: false,
  })),
}));

import {
  collectConnectorMetrics,
  renderConnectorMetrics,
  type ConnectorMetricSample,
} from "@/addons/wordpress-manager/lib/manage/metrics";
import { listExternalSites, type ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";
import {
  connectorMetrics,
  externalConnectorMetrics,
  type ConnectorMetrics,
} from "@/addons/wordpress-manager/lib/iwsl-managed-ops";
import { RPC_REGISTRY, RPC_METHODS, type ConnectorMetricsResult } from "@/addons/wordpress-manager/lib/rpc/registry";

const listMock = listExternalSites as jest.MockedFunction<typeof listExternalSites>;
const execMock = connectorMetrics as jest.MockedFunction<typeof connectorMetrics>;
const httpsMock = externalConnectorMetrics as jest.MockedFunction<typeof externalConnectorMetrics>;

function metricsResult(overrides: Partial<ConnectorMetricsResult> = {}): ConnectorMetricsResult {
  return {
    plugin: "0.4.2",
    php: "8.3.6",
    wp: "6.5",
    time_ms: 1_751_600_000_000,
    sodium: 1,
    wp_kid: 2,
    iw_kid: 1,
    wp_epoch_floor: 2,
    iw_epoch_floor: 1,
    last_seq: 19,
    nonce_cache: 3,
    rotation_pending: 0,
    last_reroll_at: 1_751_600_000,
    last_reroll_ok: 1,
    ...overrides,
  };
}

function sample(overrides: Partial<ConnectorMetricSample> = {}): ConnectorMetricSample {
  return {
    site: "blog",
    transport: "exec",
    up: true,
    roundtripMs: 2663,
    result: metricsResult(),
    cachedAt: Date.now(),
    stale: false,
    ...overrides,
  };
}

function reply(overrides: Partial<ConnectorMetrics> = {}): ConnectorMetrics {
  return { ok: true, roundtripMs: 12, result: metricsResult(), ...overrides };
}

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

/** Extract the value of a single `name{labels}` series line from the exposition. */
function seriesValue(text: string, series: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(series) && !l.startsWith("#"));
  return line?.slice(line.lastIndexOf(" ") + 1);
}

describe("renderConnectorMetrics", () => {
  test("emits an up gauge (with transport label), roundtrip, and an info gauge for a healthy link", () => {
    const text = renderConnectorMetrics([sample()]);
    expect(text).toContain('iwsl_connector_up{site="blog",transport="exec"} 1');
    expect(text).toContain('iwsl_connector_roundtrip_milliseconds{site="blog",transport="exec"} 2663');
    expect(text).toContain('iwsl_connector_info{site="blog",plugin="0.4.2",php="8.3.6",wp="6.5"} 1');
    expect(text).toContain('iwsl_connector_last_seq{site="blog"} 19');
    expect(text).toContain('iwsl_connector_wp_key_epoch{site="blog"} 2');
    expect(text).toContain('iwsl_connector_rotation_pending{site="blog"} 0');
    // Every series carries a HELP + TYPE header.
    expect(text).toContain("# HELP iwsl_connector_up ");
    expect(text).toContain("# TYPE iwsl_connector_up gauge");
    // Exposition format requires a trailing newline.
    expect(text.endsWith("\n")).toBe(true);
  });

  test("fleet scrape health reflects up/down counts", () => {
    const text = renderConnectorMetrics([
      sample({ site: "a", up: true }),
      sample({ site: "b", up: false, result: null, roundtripMs: null, error: "pod-down" }),
    ]);
    expect(seriesValue(text, "iwsl_connector_scrape_targets")).toBe("2");
    expect(seriesValue(text, "iwsl_connector_scrape_up")).toBe("1");
    // A down link still reports up=0…
    expect(text).toContain('iwsl_connector_up{site="b",transport="exec"} 0');
    // …but emits no numeric-result series (result is null) and no roundtrip.
    expect(text).not.toContain('iwsl_connector_last_seq{site="b"}');
    expect(text).not.toContain('iwsl_connector_roundtrip_milliseconds{site="b"');
    expect(text).not.toContain('iwsl_connector_info{site="b"');
  });

  test("an empty fleet is still a well-formed, non-blank exposition", () => {
    const text = renderConnectorMetrics([]);
    expect(seriesValue(text, "iwsl_connector_scrape_targets")).toBe("0");
    expect(seriesValue(text, "iwsl_connector_scrape_up")).toBe("0");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("label values from the plugin are escaped (no exposition injection)", () => {
    const text = renderConnectorMetrics([sample({ result: metricsResult({ plugin: 'a"b\\c' }) })]);
    expect(text).toContain('plugin="a\\"b\\\\c"');
  });

  test("a null wp version renders as an empty info label, not the string 'null'", () => {
    const text = renderConnectorMetrics([sample({ result: metricsResult({ wp: null }) })]);
    expect(text).toContain('wp=""');
    expect(text).not.toContain('wp="null"');
  });
});

describe("collectConnectorMetrics", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    execMock.mockResolvedValue(reply());
    httpsMock.mockResolvedValue(reply());
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy?.mockRestore());

  test("scrapes managed links over exec and external links over HTTPS", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "m1", managed: true, siteName: "managed-one" }),
      link({ siteId: "ext-1", managed: false }),
    ]);

    const samples = await collectConnectorMetrics();

    expect(execMock).toHaveBeenCalledWith("managed-one");
    expect(httpsMock).toHaveBeenCalledWith("ext-1");
    const managed = samples.find((s) => s.site === "managed-one");
    const external = samples.find((s) => s.site === "ext-1");
    expect(managed).toMatchObject({ transport: "exec", up: true, roundtripMs: 12 });
    expect(external).toMatchObject({ transport: "https", up: true });
    expect(managed?.result?.last_seq).toBe(19);
  });

  test("only active + fingerprint-confirmed links are scraped", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "m-ok", managed: true, siteName: "m-ok" }),
      link({ siteId: "m-pending", managed: true, siteName: "m-pending", state: "pending" }),
      link({ siteId: "m-unconfirmed", managed: true, siteName: "m-x", fingerprintConfirmed: false }),
      link({ siteId: "e-ok", managed: false }),
      link({ siteId: "e-quarantined", managed: false, state: "quarantined" }),
    ]);

    const samples = await collectConnectorMetrics();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(httpsMock).toHaveBeenCalledTimes(1);
    expect(samples.map((s) => s.site).sort()).toEqual(["e-ok", "m-ok"]);
  });

  test("one throwing link does not blank the batch (allSettled isolation)", async () => {
    listMock.mockResolvedValue([
      link({ siteId: "ext-dead", managed: false }),
      link({ siteId: "ext-ok", managed: false }),
    ]);
    httpsMock.mockImplementation(async (siteId: string) => {
      if (siteId === "ext-dead") throw new Error("pod exec failed");
      return reply();
    });

    const samples = await collectConnectorMetrics();

    const dead = samples.find((s) => s.site === "ext-dead");
    const ok = samples.find((s) => s.site === "ext-ok");
    expect(dead).toMatchObject({ up: false, result: null, error: "pod exec failed" });
    expect(ok).toMatchObject({ up: true });
  });

  test("a signed rejectedReason becomes up:false with the reason (no throw)", async () => {
    listMock.mockResolvedValue([link({ siteId: "ext-1", managed: false })]);
    httpsMock.mockResolvedValue(reply({ ok: false, result: {}, rejectedReason: "unknown-method" }));

    const [only] = await collectConnectorMetrics();

    expect(only).toMatchObject({ up: false, result: null, error: "unknown-method" });
  });

  test("no commandable links → empty sample list (well-formed empty scrape downstream)", async () => {
    listMock.mockResolvedValue([link({ managed: true, siteName: "m", state: "pending" })]);
    const samples = await collectConnectorMetrics();
    expect(samples).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
    expect(httpsMock).not.toHaveBeenCalled();
  });
});

describe("RPC registry parity (mirrors the plugin allow-list)", () => {
  test("metrics.snapshot is registered as a no-params method", () => {
    expect(RPC_METHODS).toContain("metrics.snapshot");
    const spec = RPC_REGISTRY["metrics.snapshot"];
    expect(spec.hasParams).toBe(false);
    expect(spec.validate({})).toBe(true);
    expect(spec.validate({ anything: 1 })).toBe(false);
  });
});
