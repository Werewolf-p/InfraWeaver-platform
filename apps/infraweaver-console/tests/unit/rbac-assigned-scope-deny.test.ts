// Guards a HIGH found in adversarial review of the storage-RBAC change.
//
// `hasAssignedPermissionForScope` is the authoritative "is this scope granted"
// check behind the NAS folder ACL (lib/nas/folder-acl.ts) and the client-side
// `useRBAC().can(perm, scope)`. It resolved with a bare `.some()` over matching
// assignments and never inspected `assignment.effect`.
//
// Two consequences, both wrong:
//   1. An Azure-style Deny carve-out on a subfolder did nothing — the broader
//      Allow on the parent still matched, so the carve-out silently failed while
//      the RBAC visualizer rendered it as enforced.
//   2. Worse: a Deny assignment on its own RETURNED TRUE, because `.some()` only
//      asked whether the assignment's role carries the permission. A Deny granted.
//
// `getEffectivePermissions` has always subtracted Deny. This helper now agrees.

import { hasAssignedPermissionForScope, hasAssignedPermissionInScopeTree, type RoleAssignment } from "@/lib/rbac";

function assignment(over: Partial<RoleAssignment> & Pick<RoleAssignment, "roleId" | "scope">): RoleAssignment {
  return {
    id: `${over.roleId}@${over.scope}@${over.effect ?? "Allow"}`,
    principalType: "user",
    principalId: "alice",
    grantedBy: "remon",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const MEDIA = "/nas/truenas/media";
const HR = "/nas/truenas/media/hr-recordings";

describe("hasAssignedPermissionForScope honours Deny", () => {
  it("grants on a plain Allow", () => {
    const grants = [assignment({ roleId: "storage-contributor", scope: MEDIA })];
    expect(hasAssignedPermissionForScope(grants, "nas:write", HR)).toBe(true);
  });

  it("a Deny assignment alone never grants", () => {
    const grants = [assignment({ roleId: "storage-contributor", scope: MEDIA, effect: "Deny" })];
    expect(hasAssignedPermissionForScope(grants, "nas:write", MEDIA)).toBe(false);
    expect(hasAssignedPermissionForScope(grants, "nas:read", MEDIA)).toBe(false);
  });

  it("a Deny on a subfolder carves out of an Allow on its parent", () => {
    const grants = [
      assignment({ roleId: "storage-contributor", scope: MEDIA }),
      assignment({ roleId: "storage-contributor", scope: HR, effect: "Deny" }),
    ];
    // The parent stays granted...
    expect(hasAssignedPermissionForScope(grants, "nas:write", MEDIA)).toBe(true);
    expect(hasAssignedPermissionForScope(grants, "nas:write", `${MEDIA}/movies`)).toBe(true);
    // ...and the carve-out actually bites, at the scope and beneath it.
    expect(hasAssignedPermissionForScope(grants, "nas:write", HR)).toBe(false);
    expect(hasAssignedPermissionForScope(grants, "nas:read", HR)).toBe(false);
    expect(hasAssignedPermissionForScope(grants, "nas:write", `${HR}/2026-q1`)).toBe(false);
  });

  it("Deny wins regardless of assignment order", () => {
    const denyFirst = [
      assignment({ roleId: "storage-contributor", scope: HR, effect: "Deny" }),
      assignment({ roleId: "storage-contributor", scope: MEDIA }),
    ];
    expect(hasAssignedPermissionForScope(denyFirst, "nas:write", HR)).toBe(false);
  });

  it("a Deny of a permission the caller was never granted is inert", () => {
    const grants = [
      assignment({ roleId: "storage-viewer", scope: MEDIA }),
      assignment({ roleId: "storage-contributor", scope: HR, effect: "Deny" }),
    ];
    expect(hasAssignedPermissionForScope(grants, "nas:read", MEDIA)).toBe(true);
    // read is denied under HR because storage-contributor carries nas:read too.
    expect(hasAssignedPermissionForScope(grants, "nas:read", HR)).toBe(false);
  });

  it("an expired Deny stops denying", () => {
    const grants = [
      assignment({ roleId: "storage-contributor", scope: MEDIA }),
      assignment({ roleId: "storage-contributor", scope: HR, effect: "Deny", expiresAt: "2020-01-01T00:00:00.000Z" }),
    ];
    expect(hasAssignedPermissionForScope(grants, "nas:write", HR)).toBe(true);
  });

  it("a Deny narrower than the requested scope does not deny the parent", () => {
    const grants = [
      assignment({ roleId: "storage-contributor", scope: MEDIA }),
      assignment({ roleId: "storage-contributor", scope: HR, effect: "Deny" }),
    ];
    expect(hasAssignedPermissionForScope(grants, "nas:write", MEDIA)).toBe(true);
  });
});

describe("hasAssignedPermissionInScopeTree ignores Deny assignments", () => {
  it("a Deny-only assignment does not admit a caller to the storage subtree", () => {
    // Admission must not be satisfied by an assignment that only takes access away.
    const grants = [assignment({ roleId: "storage-contributor", scope: MEDIA, effect: "Deny" })];
    expect(hasAssignedPermissionInScopeTree(grants, "nas:write", "/nas")).toBe(false);
  });

  it("an Allow anywhere in the subtree still admits", () => {
    const grants = [assignment({ roleId: "storage-viewer", scope: MEDIA })];
    expect(hasAssignedPermissionInScopeTree(grants, "nas:read", "/nas")).toBe(true);
  });
});
