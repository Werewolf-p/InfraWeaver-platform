// The RBAC-ceiling guard is the security core of self-service. These tests prove
// the central invariant: autoApply ⟺ (within requester ceiling) AND (self-
// executable primitive). A self-request can NEVER self-escalate — a role that
// exceeds the requester's own ceiling always routes to admin approval, and
// storage-quota always queues even within ceiling (its primitive is admin-only).

jest.mock("server-only", () => ({}), { virtual: true });
// session-rbac value-imports these; permissionsBeyondCeiling never calls them, so
// stubbing keeps the guard test hermetic (no ConfigMap / users.yaml / PIM I/O).
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/users-config", () => ({
  getRoleAssignmentsForSession: jest.fn(),
  getGroupRoleAssignmentsForSession: jest.fn(),
}));
jest.mock("@/lib/pim", () => ({ computeExtraPermissions: jest.fn(() => new Set()) }));

import type { RoleAssignment, RoleId } from "@/lib/rbac";
import type { SessionRBACContext } from "@/lib/session-rbac";
import { evaluateAutoApply, validateSubmittable, type OwnedPvcRef } from "@/lib/self-service/evaluate";
import type { SelfServiceRequest, SelfServicePayload } from "@/lib/self-service/types";

/** A requester context holding one built-in role at "/" (drives real ceiling math). */
function ctxWithRole(roleId: RoleId): SessionRBACContext {
  const assignment: RoleAssignment = {
    id: "req-ra",
    roleId,
    scope: "/",
    principalType: "user",
    principalId: "requester",
    grantedBy: "system",
    grantedAt: "2026-01-01T00:00:00.000Z",
  };
  return { groups: [], username: "requester", roleAssignments: [assignment], extraPermissions: [] };
}

/** A requester context with no role at all (holds nothing). */
function emptyCtx(): SessionRBACContext {
  return { groups: [], username: "requester", roleAssignments: [], extraPermissions: [] };
}

function makeRequest(type: SelfServiceRequest["type"], payload: SelfServicePayload): SelfServiceRequest {
  return {
    id: "candidate",
    type,
    status: "pending",
    requestedBy: "requester@example.com",
    requestedByGroups: [],
    payload,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

describe("evaluateAutoApply — app-access ceiling routing", () => {
  it("auto-applies an app-access request that is within the requester's ceiling", () => {
    // Arrange: requester is an Editor at "/"; they request the subset Reader role.
    const ctx = ctxWithRole("editor");
    const request = makeRequest("app-access", { roleId: "reader", scope: "/" });

    // Act
    const decision = evaluateAutoApply(ctx, request);

    // Assert
    expect(decision.autoApply).toBe(true);
    expect(decision.withinCeiling).toBe(true);
    expect(decision.beyond).toHaveLength(0);
  });

  it("queues an app-access request that exceeds the requester's ceiling", () => {
    // Arrange: a Reader requests the strictly-broader Editor role.
    const ctx = ctxWithRole("reader");
    const request = makeRequest("app-access", { roleId: "editor", scope: "/" });

    // Act
    const decision = evaluateAutoApply(ctx, request);

    // Assert
    expect(decision.autoApply).toBe(false);
    expect(decision.withinCeiling).toBe(false);
    expect(decision.beyond.length).toBeGreaterThan(0);
  });

  it("never self-escalates: a platform-admin requesting owner '*' is routed to approval", () => {
    // Arrange: platform-admin lacks the "*" that Owner confers.
    const ctx = ctxWithRole("platform-admin");
    const request = makeRequest("app-access", { roleId: "owner", scope: "/" });

    // Act
    const decision = evaluateAutoApply(ctx, request);

    // Assert: the escalation attempt cannot auto-apply.
    expect(decision.autoApply).toBe(false);
    expect(decision.withinCeiling).toBe(false);
    expect(decision.beyond).toContain("*");
  });
});

describe("evaluateAutoApply — always-queue and always-auto types", () => {
  it("always queues storage-quota even when nas:write is within ceiling", () => {
    // Arrange: an Owner holds "*", so nas:write is within ceiling…
    const ctx = ctxWithRole("owner");
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: "/nas/truenas/media", requestedSize: "20Gi" });

    // Act
    const decision = evaluateAutoApply(ctx, request);

    // Assert: …but the PVC-patch primitive is admin-only, so it never auto-applies.
    expect(decision.withinCeiling).toBe(true);
    expect(decision.selfExecutable).toBe(false);
    expect(decision.autoApply).toBe(false);
  });

  it("always auto-applies a password reset (own account, no permission conferred)", () => {
    const decision = evaluateAutoApply(emptyCtx(), makeRequest("password-reset", {}));
    expect(decision.autoApply).toBe(true);
    expect(decision.beyond).toHaveLength(0);
  });

  it("always auto-applies a profile update (own identity, no permission conferred)", () => {
    const decision = evaluateAutoApply(emptyCtx(), makeRequest("profile-update", { field: "name", value: "New Name" }));
    expect(decision.autoApply).toBe(true);
    expect(decision.selfExecutable).toBe(true);
  });
});

describe("validateSubmittable — storage-quota is bounded to the requester's own PVCs", () => {
  const ownScope = "/nas/truenas/media";
  const ownedRw: OwnedPvcRef[] = [{ namespace: "ns", name: "pvc", scope: ownScope }];

  it("accepts a quota request against an owned, writable volume", () => {
    // Arrange: Owner holds nas:write everywhere; the PVC is in their owned set.
    const ctx = ctxWithRole("owner");
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: ownScope, requestedSize: "20Gi" });

    // Act / Assert
    expect(validateSubmittable(ctx, request, ownedRw)).toEqual({ ok: true });
  });

  it("rejects a quota request against a volume the requester does not own", () => {
    const ctx = ctxWithRole("owner");
    const request = makeRequest("storage-quota", { namespace: "other", pvcName: "stranger", scope: ownScope, requestedSize: "20Gi" });

    const result = validateSubmittable(ctx, request, ownedRw);
    expect(result).toEqual({ ok: false, status: 403, error: expect.stringContaining("assigned to you") });
  });

  it("rejects a quota request on an owned volume the requester cannot write", () => {
    // Arrange: storage-viewer holds nas:read but NOT nas:write at the scope.
    const ctx = ctxWithRole("storage-viewer");
    const scopedOwned: OwnedPvcRef[] = [{ namespace: "ns", name: "pvc", scope: ownScope }];
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: ownScope, requestedSize: "20Gi" });

    const result = validateSubmittable(ctx, request, scopedOwned);
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(403);
  });

  it("rejects a quota request whose scope does not match the owned volume's scope", () => {
    const ctx = ctxWithRole("owner");
    const request = makeRequest("storage-quota", { namespace: "ns", pvcName: "pvc", scope: "/nas/truenas/other", requestedSize: "20Gi" });

    const result = validateSubmittable(ctx, request, ownedRw);
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining("Scope") });
  });

  it("passes non-storage request types through without a PVC check", () => {
    const ctx = emptyCtx();
    expect(validateSubmittable(ctx, makeRequest("password-reset", {}), [])).toEqual({ ok: true });
    expect(validateSubmittable(ctx, makeRequest("app-access", { roleId: "reader", scope: "/" }), [])).toEqual({ ok: true });
  });
});
