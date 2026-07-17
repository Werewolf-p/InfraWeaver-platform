/**
 * Guards the Cluster Vitals PromQL wiring: the ingress tiles must query Traefik
 * entrypoint metrics (this platform's ingress controller is Traefik, not nginx),
 * scoped to the public web/websecure entrypoints, so both ingress tiles populate
 * instead of degrading to "—". Regression guard for the nginx → Traefik fix.
 */
const promScalar = jest.fn<Promise<number | null>, [string]>();

// Stub next/server so importing the route handler doesn't pull in the web
// Request/Response globals (absent in the jsdom test env). The handler's
// response is not inspected here — only the PromQL passed to promScalar is.
jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
}));

jest.mock("@/lib/prometheus", () => ({
  isPrometheusConfigured: () => true,
  promScalar: (query: string) => promScalar(query),
}));

// Bypass auth/RBAC — the handler ignores its request args, so return it raw.
jest.mock("@/lib/with-auth", () => ({
  withAuth: (_opts: unknown, handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "@/app/api/metrics/cluster-vitals/route";

type RawHandler = (req?: unknown, segment?: unknown) => Promise<unknown>;

describe("cluster-vitals PromQL", () => {
  beforeEach(() => {
    promScalar.mockReset();
    promScalar.mockResolvedValue(1);
  });

  it("queries Traefik entrypoint metrics for ingress, never nginx", async () => {
    await (GET as unknown as RawHandler)();

    const queries = promScalar.mock.calls.map((call) => call[0]);

    // The old nginx metric must be gone entirely.
    expect(queries.join("\n")).not.toContain("nginx_ingress_controller_requests");

    // Exactly the two ingress tiles use the Traefik entrypoint counter.
    const ingressQueries = queries.filter((q) => q.includes("traefik_entrypoint_requests_total"));
    expect(ingressQueries).toHaveLength(2);

    // Both scope to the public entrypoints only (exclude dashboard/metrics).
    for (const q of ingressQueries) {
      expect(q).toMatch(/entrypoint=~"web\|websecure"/);
    }

    // The 5xx tile must filter on Traefik's `code` label (nginx used `status`).
    expect(ingressQueries.some((q) => /code=~"5\.\."/.test(q))).toBe(true);
  });
});
