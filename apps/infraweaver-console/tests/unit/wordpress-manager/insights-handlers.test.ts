/** @jest-environment node */
// The Insights read route: RBAC gate (wordpress:read) + rate-limit + param
// validation, then delegate to the signed `stats.*` / `activity.log` ops. Proves
// the reads are gated exactly like every managed op, that a locked response is a
// NORMAL 200 (not an error), and that bad params never reach the signed channel.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: jest.fn(() => true) }));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ WpPodExecError: class WpPodExecError extends Error {} }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  statsSummary: jest.fn(),
  statsTimeseries: jest.fn(),
  activityLog: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/wordpress-rbac", () => ({
  getWordpressAccessContext: jest.fn(),
  hasWordpressPermission: jest.fn(),
}));

import { insightsReadHandler } from "@/addons/wordpress-manager/api/insights-handlers";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getWordpressAccessContext, hasWordpressPermission } from "@/addons/wordpress-manager/lib/wordpress-rbac";
import { activityLog, statsSummary, statsTimeseries } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";

const authMock = auth as jest.MockedFunction<typeof auth>;
const rateMock = checkRateLimit as jest.MockedFunction<typeof checkRateLimit>;
const ctxMock = getWordpressAccessContext as jest.MockedFunction<typeof getWordpressAccessContext>;
const permMock = hasWordpressPermission as jest.MockedFunction<typeof hasWordpressPermission>;
const summaryMock = statsSummary as jest.MockedFunction<typeof statsSummary>;
const seriesMock = statsTimeseries as jest.MockedFunction<typeof statsTimeseries>;
const activityMock = activityLog as jest.MockedFunction<typeof activityLog>;

const SITE = "blog";

function req(query: string) {
  return {
    url: `http://console.test/api/wordpress/sites/${SITE}/insights?${query}`,
  } as unknown as Parameters<typeof insightsReadHandler>[0];
}
function withP(verb: string, params: unknown): string {
  return `read=${verb}&p=${encodeURIComponent(JSON.stringify(params))}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  rateMock.mockReturnValue(true);
  ctxMock.mockResolvedValue({
    groups: [],
    username: "alice",
    roleAssignments: [],
    isAdmin: false,
  } as Awaited<ReturnType<typeof getWordpressAccessContext>>);
});

describe("insightsReadHandler — gating", () => {
  test("401 when unauthenticated (no signed read)", async () => {
    authMock.mockResolvedValue(null as never);
    const res = await insightsReadHandler(req(withP("summary", { range_days: 7 })), SITE);
    expect(res.status).toBe(401);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  test("403 when the session lacks wordpress:read", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(false);
    const res = await insightsReadHandler(req(withP("summary", {})), SITE);
    expect(res.status).toBe(403);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  test("wordpress:read is the permission demanded", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    summaryMock.mockResolvedValue({ locked: false } as never);
    await insightsReadHandler(req(withP("summary", {})), SITE);
    expect(permMock).toHaveBeenCalled();
    for (const call of permMock.mock.calls) expect(call[3]).toBe("wordpress:read");
  });

  test("429 when rate-limited (never reaches the signed channel)", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    rateMock.mockReturnValue(false);
    const res = await insightsReadHandler(req(withP("summary", {})), SITE);
    expect(res.status).toBe(429);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  test("400 on an unknown read verb", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    const res = await insightsReadHandler(req("read=bogus"), SITE);
    expect(res.status).toBe(400);
  });

  test("400 on an invalid site id", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    const bad = { url: "http://console.test/api/wordpress/sites/Bad_Id!/insights?read=summary" } as unknown as Parameters<
      typeof insightsReadHandler
    >[0];
    const res = await insightsReadHandler(bad, "Bad_Id!");
    expect(res.status).toBe(400);
  });
});

describe("insightsReadHandler — delegation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
  });

  test("summary success delegates with parsed params and returns the body", async () => {
    const body = { locked: false, range_days: 7, kpi: { views: 42 } };
    summaryMock.mockResolvedValue(body as never);
    const res = await insightsReadHandler(req(withP("summary", { range_days: 7 })), SITE);
    expect(res.status).toBe(200);
    expect(summaryMock).toHaveBeenCalledWith(SITE, { range_days: 7 });
    await expect(res.json()).resolves.toEqual(body);
  });

  test("a locked response is a NORMAL 200 (not an error, never fabricated)", async () => {
    const locked = { locked: true, gate: { reasons: ["requires-plus"] } };
    summaryMock.mockResolvedValue(locked as never);
    const res = await insightsReadHandler(req(withP("summary", {})), SITE);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(locked);
  });

  test("400 on invalid summary params (range 3) — never reaches the signed channel", async () => {
    const res = await insightsReadHandler(req(withP("summary", { range_days: 3 })), SITE);
    expect(res.status).toBe(400);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  test("timeseries success delegates with days", async () => {
    seriesMock.mockResolvedValue({ locked: false, days: 30, series: [] } as never);
    const res = await insightsReadHandler(req(withP("timeseries", { days: 30 })), SITE);
    expect(res.status).toBe(200);
    expect(seriesMock).toHaveBeenCalledWith(SITE, { days: 30 });
  });

  test("activity success delegates with limit", async () => {
    activityMock.mockResolvedValue({ locked: false, entries: [] } as never);
    const res = await insightsReadHandler(req(withP("activity", { limit: 50 })), SITE);
    expect(res.status).toBe(200);
    expect(activityMock).toHaveBeenCalledWith(SITE, { limit: 50 });
  });

  test("empty params default at the connector (summary called with {})", async () => {
    summaryMock.mockResolvedValue({ locked: false } as never);
    const res = await insightsReadHandler(req("read=summary"), SITE);
    expect(res.status).toBe(200);
    expect(summaryMock).toHaveBeenCalledWith(SITE, {});
  });
});
