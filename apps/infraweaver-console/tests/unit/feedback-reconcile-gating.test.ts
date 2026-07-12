// Guards the read-path privilege fix on GET /api/feedback: reconcileStaleEntries()
// issues outbound dispatch mutations, so it must only run for feedback MANAGErs
// (rbac:admin / cluster:admin). A low-privilege reader (apps:read / cluster:read)
// must get the list as-is and never trigger a dispatch call.

// The route guards with `session instanceof Response`; the node test env has no
// global Response. A minimal constructor suffices — our mocked session is a plain
// object, so the instanceof check correctly stays false.
(globalThis as { Response?: unknown }).Response ??= class {};

// The route imports the shared FEEDBACK_MANAGE_PERMISSIONS from feedback-host,
// which is a server module; neutralize the `server-only` marker under jest.
jest.mock("server-only", () => ({}), { virtual: true });

const reconcileStaleEntries = jest.fn(async () => {});
const listFeedback = jest.fn();
const hasAnySessionPermission = jest.fn();
const getSessionRBACContext = jest.fn(async () => ({ permissions: [] }));

jest.mock("@/lib/route-utils", () => ({
  requireRoutePermissions: jest.fn(async () => ({ user: { email: "u@x" } })),
  apiSuccess: (data: unknown) => ({ ok: true, data }),
  apiError: (msg: string, opts?: { status?: number }) => ({ ok: false, msg, status: opts?.status }),
  routeErrorResponse: (err: unknown) => ({ ok: false, err }),
}));
jest.mock("@/lib/session-rbac", () => ({ getSessionRBACContext, hasAnySessionPermission }));
jest.mock("@/lib/feedback-store", () => ({
  listFeedback,
  createFeedback: jest.fn(),
  FEEDBACK_TYPES: ["bug"],
  FEEDBACK_SEVERITIES: ["low"],
}));
jest.mock("@/lib/feedback-dispatch", () => ({ isDispatchConfigured: () => true }));
jest.mock("@/lib/feedback-pipeline", () => ({ needsReconcile: () => true, reconcileStaleEntries }));
jest.mock("@/lib/hmac", () => ({ signHmac: () => "sig", verifyHmac: () => true }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true, rateLimitKey: () => "k" }));

import { GET } from "@/app/api/feedback/route";

const STALE = [{ id: "1", status: "dispatched" }];

describe("GET /api/feedback — reconcile gating", () => {
  beforeEach(() => {
    reconcileStaleEntries.mockClear();
    hasAnySessionPermission.mockReset();
    listFeedback.mockReset().mockResolvedValue(STALE);
  });

  it("does NOT reconcile for a low-privilege reader (no MANAGE permission)", async () => {
    hasAnySessionPermission.mockReturnValue(false);
    const res = (await GET()) as { ok: boolean; data: { entries: unknown[] } };
    expect(reconcileStaleEntries).not.toHaveBeenCalled();
    expect(res.data.entries).toEqual(STALE);
  });

  it("DOES reconcile for a feedback manager (rbac:admin / cluster:admin)", async () => {
    hasAnySessionPermission.mockReturnValue(true);
    await GET();
    expect(reconcileStaleEntries).toHaveBeenCalledTimes(1);
    expect(hasAnySessionPermission).toHaveBeenCalledWith(expect.anything(), ["rbac:admin", "cluster:admin"]);
  });
});
