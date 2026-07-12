// Validates the BOLA fix on GET /api/logs/analytics: a holder of apps:read that
// is NOT authorized for the target pod (requireLogsTargetAccess → 403) must get
// 403 and must never reach the Kubernetes log read. Mirrors the scoping every
// sibling log route enforces.

// next/server is ESM-only under Jest; stub NextResponse with a minimal class so
// the route/withAuth `instanceof NextResponse` guards work and `.status` is
// readable (mirrors tests/unit/game-hub-restart-access-log.test.ts).
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("next/server", () => {
  class NextResponse {
    body: unknown;
    status: number;
    constructor(body?: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    static json(body: unknown, init?: { status?: number }) {
      return new NextResponse(body, init);
    }
  }
  return { NextResponse };
});

const readNamespacedPodLog = jest.fn(async () => "error boom\ninfo ok\n");
const canAccessLogsTarget = jest.fn();
const hasSessionPermission = jest.fn(() => true);

jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "u@x", groups: [] } })) }));
jest.mock("@/lib/session-rbac", () => ({
  getSessionRBACContext: jest.fn(async () => ({ permissions: ["apps:read"] })),
  hasSessionPermission,
  // withAuth guards through the ANY-of helper; keep it toggled by the same fn.
  hasAnySessionPermission: jest.fn(() => hasSessionPermission()),
}));
jest.mock("@/lib/cluster-context", () => ({ getRequestClusterId: () => "local" }));
// The REAL @/lib/logs-route-helpers guard runs on top of these fakes, so the
// route is exercised through the actual requireLogsTargetAccess logic.
jest.mock("@/lib/logs-access", () => ({
  canAccessLogsTarget,
  getGameHubAccessContext: jest.fn(async () => ({ groups: [], username: "koen", roleAssignments: [] })),
  fetchPodLogText: jest.fn(
    async (coreApi: { readNamespacedPodLog: (opts: unknown) => Promise<string> }, opts: unknown) =>
      coreApi.readNamespacedPodLog(opts),
  ),
}));
jest.mock("@/lib/k8s", () => ({
  loadKubeConfig: () => ({ makeApiClient: () => ({ readNamespacedPodLog }) }),
}));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true, rateLimitKey: () => "k" }));
jest.mock("@/lib/validate", () => ({
  isValidNamespace: () => true,
  isValidK8sName: () => true,
  isValidContainerName: () => true,
}));
jest.mock("@kubernetes/client-node", () => ({ CoreV1Api: class {} }), { virtual: true });

import { GET } from "@/app/api/logs/analytics/route";

function reqFor(namespace: string, pod: string) {
  return {
    nextUrl: { searchParams: new URLSearchParams({ namespace, pod }) },
  } as unknown as import("next/server").NextRequest;
}

describe("GET /api/logs/analytics — BOLA scoping", () => {
  beforeEach(() => {
    readNamespacedPodLog.mockClear();
    canAccessLogsTarget.mockReset();
    hasSessionPermission.mockReturnValue(true);
  });

  it("returns 403 and never reads logs when the caller is not authorized for the target pod", async () => {
    canAccessLogsTarget.mockReturnValue(false);
    const res = (await GET(reqFor("authentik", "authentik-server-0"), { params: Promise.resolve({}) })) as unknown as { status: number };
    expect(res.status).toBe(403);
    expect(readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it("proceeds to read logs when the caller IS authorized for the target pod", async () => {
    canAccessLogsTarget.mockReturnValue(true);
    await GET(reqFor("game-hub", "my-server-0"), { params: Promise.resolve({}) });
    expect(readNamespacedPodLog).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the caller lacks apps:read entirely", async () => {
    hasSessionPermission.mockReturnValue(false);
    const res = (await GET(reqFor("game-hub", "my-server-0"), { params: Promise.resolve({}) })) as unknown as { status: number };
    expect(res.status).toBe(403);
    expect(readNamespacedPodLog).not.toHaveBeenCalled();
  });
});
