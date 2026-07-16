// The apply executors reuse existing primitives without forking them. These tests
// prove app-access flows through the single grant choke point (applyRoleAssignments)
// under the ACTING principal's granterPermsAt, that a ceiling breach's 403 is
// propagated (never over-granted), and that storage-quota calls expandPvc.

jest.mock("server-only", () => ({}), { virtual: true });

const applyRoleAssignments = jest.fn();
jest.mock("@/lib/rbac-assignments", () => ({
  applyRoleAssignments: (...args: unknown[]) => applyRoleAssignments(...args),
}));

const expandPvc = jest.fn();
jest.mock("@/lib/storage/expand-pvc", () => ({
  expandPvc: (...args: unknown[]) => expandPvc(...args),
}));

const getSessionEffectivePermissions = jest.fn(() => new Set<string>(["apps:read"]));
jest.mock("@/lib/session-rbac", () => ({
  getSessionEffectivePermissions: (...args: unknown[]) => getSessionEffectivePermissions(...args),
}));

const authentikFetch = jest.fn();
const findUserByEmail = jest.fn();
jest.mock("@/lib/authentik", () => ({
  authentikFetch: (...args: unknown[]) => authentikFetch(...args),
  findUserByEmail: (...args: unknown[]) => findUserByEmail(...args),
}));

// applyAppAccess resolves the requester's users.yaml KEY from their email. Map
// alice@example.com → the "alice" key so grants target the canonical principal.
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: jest.fn(async () => ({ users: { alice: { email: "alice@example.com" } }, groups: {}, sha: "s", raw: "" })),
  findUserByIdentity: (users: Record<string, { email?: string }>, id: { username?: string; email?: string }) => {
    if (id.username && users[id.username]) return { username: id.username, user: users[id.username] };
    if (id.email) {
      const entry = Object.entries(users).find(([, user]) => user.email === id.email);
      if (entry) return { username: entry[0], user: entry[1] };
    }
    return null;
  },
}));

import { applyAppAccess, applyStorageQuota, executeRequest } from "@/lib/self-service/apply";
import type { SessionRBACContext } from "@/lib/session-rbac";
import type { SelfServiceRequest, SelfServicePayload } from "@/lib/self-service/types";

const approverCtx = { groups: [], username: "admin", roleAssignments: [], extraPermissions: [] } as unknown as SessionRBACContext;

function makeRequest(type: SelfServiceRequest["type"], payload: SelfServicePayload): SelfServiceRequest {
  return {
    id: "r1",
    type,
    status: "pending",
    requestedBy: "alice@example.com",
    requestedByGroups: [],
    payload,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

beforeEach(() => {
  applyRoleAssignments.mockReset();
  expandPvc.mockReset();
  getSessionEffectivePermissions.mockClear();
  authentikFetch.mockReset();
  findUserByEmail.mockReset();
});

describe("applyAppAccess", () => {
  it("grants via applyRoleAssignments using the approver's granterPermsAt", async () => {
    // Arrange
    applyRoleAssignments.mockResolvedValue({ ok: true, assignments: [], grantedCount: 1, revokedCount: 0 });
    const request = makeRequest("app-access", { roleId: "reader", scope: "/wordpress" });

    // Act
    const outcome = await applyAppAccess(request, { actorCtx: approverCtx, actor: "admin@x" });

    // Assert
    expect(outcome).toEqual({ ok: true, summary: expect.stringContaining("Reader") });
    const [input, ctx] = applyRoleAssignments.mock.calls[0];
    expect(input).toEqual({
      principalType: "user",
      principal: "alice", // resolved from the requester's email to their users.yaml key
      grants: [{ roleId: "reader", scope: "/wordpress" }],
      revokes: [],
    });
    // granterPermsAt resolves the approver's own permission set — the ceiling anchor.
    ctx.granterPermsAt("/wordpress");
    expect(getSessionEffectivePermissions).toHaveBeenCalledWith(approverCtx, "/wordpress");
    expect(ctx.actor).toBe("admin@x");
  });

  it("propagates a ceiling breach 403 from the grant choke point (never over-grants)", async () => {
    // Arrange: the choke point rejects because the role exceeds the actor.
    applyRoleAssignments.mockResolvedValue({ ok: false, status: 403, error: "Cannot grant a role that exceeds your own permissions" });
    const request = makeRequest("app-access", { roleId: "owner", scope: "/" });

    // Act
    const outcome = await applyAppAccess(request, { actorCtx: approverCtx, actor: "admin@x" });

    // Assert
    expect(outcome).toEqual({ ok: false, status: 403, error: expect.stringContaining("exceeds your own permissions") });
  });
});

describe("applyStorageQuota", () => {
  it("expands the target PVC via expandPvc and summarizes the result", async () => {
    // Arrange
    expandPvc.mockResolvedValue({ namespace: "ns", name: "pvc", requestedStorage: "20Gi", capacity: "20Gi" });
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: "/nas/truenas/media", requestedSize: "20Gi" });

    // Act
    const outcome = await applyStorageQuota(request);

    // Assert
    expect(expandPvc).toHaveBeenCalledWith({ namespace: "ns", name: "pvc", newSize: "20Gi" });
    expect(outcome).toEqual({ ok: true, summary: expect.stringContaining("20Gi") });
  });

  it("maps an expand failure to a 502 outcome", async () => {
    expandPvc.mockRejectedValue(new Error("api down"));
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: "/nas/truenas/media", requestedSize: "20Gi" });

    const outcome = await applyStorageQuota(request);
    expect(outcome).toEqual({ ok: false, status: 502, error: expect.stringContaining("api down") });
  });
});

describe("executeRequest dispatch", () => {
  it("routes password-reset to the Authentik recovery flow and returns the link once", async () => {
    // Arrange
    findUserByEmail.mockResolvedValue({ pk: 42 });
    authentikFetch.mockResolvedValue({ ok: true, json: async () => ({ link: "https://authentik/recovery/abc" }) });

    // Act
    const outcome = await executeRequest(makeRequest("password-reset", {}), { actorCtx: approverCtx, actor: "alice@example.com" });

    // Assert
    expect(authentikFetch).toHaveBeenCalledWith("/core/users/42/recovery/", { method: "POST" });
    expect(outcome).toEqual({ ok: true, summary: expect.any(String), recoveryLink: "https://authentik/recovery/abc" });
  });

  it("routes app-access through applyRoleAssignments", async () => {
    applyRoleAssignments.mockResolvedValue({ ok: true, assignments: [] });
    const outcome = await executeRequest(makeRequest("app-access", { roleId: "reader", scope: "/" }), { actorCtx: approverCtx, actor: "admin@x" });
    expect(outcome.ok).toBe(true);
    expect(applyRoleAssignments).toHaveBeenCalledTimes(1);
  });
});
