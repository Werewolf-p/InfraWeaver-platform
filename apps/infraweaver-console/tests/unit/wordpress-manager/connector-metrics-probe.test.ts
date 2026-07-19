/** @jest-environment node */
// Metrics panel probe: a live signed metrics.snapshot read (never persisted) plus
// a read-only Prometheus range query for history. Verifies both halves degrade
// independently, the live read never throws, and the PromQL label matcher can't
// be injected through the site id.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/lib/prometheus", () => ({
  isPrometheusConfigured: jest.fn(() => true),
  promQueryRange: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  connectorMetrics: jest.fn(),
}));

import { metricsProbe } from "@/addons/wordpress-manager/lib/manage/probes/metrics";
import type { PanelProbeContext } from "@/addons/wordpress-manager/lib/manage/probes/contract";
import { isPrometheusConfigured, promQueryRange } from "@/lib/prometheus";
import { connectorMetrics, type ConnectorMetrics } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";

const promConfigured = isPrometheusConfigured as jest.MockedFunction<typeof isPrometheusConfigured>;
const promRange = promQueryRange as jest.MockedFunction<typeof promQueryRange>;
const liveMock = connectorMetrics as jest.MockedFunction<typeof connectorMetrics>;

function ctx(site = "blog"): PanelProbeContext {
  return {
    site,
    pod: "blog-wp-0",
    exec: jest.fn(),
    capabilities: { connector: true } as PanelProbeContext["capabilities"],
    managed: null,
  };
}

function reply(overrides: Partial<ConnectorMetrics> = {}): ConnectorMetrics {
  return {
    ok: true,
    roundtripMs: 2663,
    result: {
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
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  promConfigured.mockReturnValue(true);
  liveMock.mockResolvedValue(reply());
  promRange.mockResolvedValue([{ metric: {}, values: [[1_751_600_000, "1"], [1_751_600_300, "1"]] }]);
});

describe("metricsProbe live read", () => {
  test("returns a verified live snapshot with a checkedAt stamp (not persisted)", async () => {
    const data = await metricsProbe.fetch(ctx());
    expect(liveMock).toHaveBeenCalledWith("blog");
    expect(data.live.ok).toBe(true);
    expect(data.live.result?.last_seq).toBe(19);
    expect(Number.isNaN(Date.parse(data.live.checkedAt))).toBe(false);
  });

  test("a plugin rejection is surfaced as up:false with the reason, result null", async () => {
    liveMock.mockResolvedValue(reply({ ok: false, result: {}, rejectedReason: "unknown-method" }));
    const data = await metricsProbe.fetch(ctx());
    expect(data.live.ok).toBe(false);
    expect(data.live.error).toBe("unknown-method");
    expect(data.live.result).toBeNull();
  });

  test("a thrown transport/quarantine error never blanks the panel", async () => {
    liveMock.mockRejectedValue(new Error("link has been quarantined"));
    const data = await metricsProbe.fetch(ctx());
    expect(data.live.ok).toBe(false);
    expect(data.live.error).toContain("quarantined");
  });
});

describe("metricsProbe history read", () => {
  test("returns Prometheus series when configured", async () => {
    const data = await metricsProbe.fetch(ctx());
    expect(data.history.available).toBe(true);
    expect(data.history.series.length).toBeGreaterThan(0);
    // Each history spec queried by the site-scoped selector.
    expect(promRange).toHaveBeenCalledWith(expect.stringContaining('{site="blog"}'), expect.any(Object));
    const up = data.history.series.find((s) => s.id === "up");
    expect(up?.points.at(-1)).toEqual({ t: 1_751_600_300, v: 1 });
  });

  test("degrades to unavailable (with reason) when Prometheus is not configured — live still works", async () => {
    promConfigured.mockReturnValue(false);
    const data = await metricsProbe.fetch(ctx());
    expect(data.history.available).toBe(false);
    expect(data.history.reason).toMatch(/PROMETHEUS_URL/);
    expect(promRange).not.toHaveBeenCalled();
    // The live read is independent and still succeeded.
    expect(data.live.ok).toBe(true);
  });

  test("a Prometheus error degrades history but leaves the live read intact", async () => {
    promRange.mockRejectedValue(new Error("Prometheus query failed (503)"));
    const data = await metricsProbe.fetch(ctx());
    expect(data.history.available).toBe(false);
    expect(data.history.reason).toContain("503");
    expect(data.live.ok).toBe(true);
  });

  test("a site id that isn't a plain slug can't reach a PromQL selector (no injection)", async () => {
    const data = await metricsProbe.fetch(ctx('blog"} or up{'));
    expect(data.history.available).toBe(false);
    expect(promRange).not.toHaveBeenCalled();
  });
});
