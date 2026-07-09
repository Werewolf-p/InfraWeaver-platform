// Guards C1 (SECURITY-SCAN-2026-07-08): a `users:write` actor must not be able
// to set privileged authorization fields (role_assignments / authentik_groups /
// access_level) through the generic user create/edit paths, which bypass the
// grant privilege-ceiling. The single-user PUT rejects them outright; the bulk
// save preserves the stored values instead of trusting the request body.

import {
  PRIVILEGED_USER_FIELDS,
  findPrivilegedFields,
  preservePrivilegedFields,
  DEFAULT_USER_PRIVILEGES,
} from "@/lib/users-config-guard";

describe("findPrivilegedFields — escalation-vector detection for generic user edit", () => {
  it("flags each privileged field when present", () => {
    expect(findPrivilegedFields({ role_assignments: [] })).toEqual(["role_assignments"]);
    expect(findPrivilegedFields({ authentik_groups: ["platform-admins"] })).toEqual(["authentik_groups"]);
    expect(findPrivilegedFields({ access_level: "admin" })).toEqual(["access_level"]);
  });

  it("flags multiple privileged fields together, in canonical order", () => {
    const body = { name: "Mallory", access_level: "admin", role_assignments: [{ roleId: "platform-owner" }] };
    expect(findPrivilegedFields(body)).toEqual(["role_assignments", "access_level"]);
  });

  it("returns [] for a body of only non-privileged profile fields", () => {
    expect(findPrivilegedFields({ name: "Alice", email: "a@x", wiki_role: "editor" })).toEqual([]);
  });

  it("treats an explicit undefined value as present (own key)", () => {
    // A client that spreads a full record with access_level: undefined must still
    // be caught rather than silently allowed to fall through.
    expect(findPrivilegedFields({ access_level: undefined })).toEqual(["access_level"]);
  });

  it("covers exactly the three documented privileged fields", () => {
    expect([...PRIVILEGED_USER_FIELDS].sort()).toEqual(["access_level", "authentik_groups", "role_assignments"]);
  });
});

describe("preservePrivilegedFields — bulk save cannot mutate privileged fields", () => {
  it("drops incoming privileged fields and re-applies the stored values", () => {
    const stored = { access_level: "viewer", authentik_groups: ["platform-users"], name: "Old" };
    const incoming = {
      name: "New Name",
      access_level: "admin", // escalation attempt
      role_assignments: [{ roleId: "platform-owner", scope: "/" }], // escalation attempt
      authentik_groups: ["platform-admins"], // escalation attempt
    };
    const result = preservePrivilegedFields(incoming, stored);

    // Non-privileged edit is honored.
    expect(result.name).toBe("New Name");
    // Privileged fields come from stored, not the request.
    expect(result.access_level).toBe("viewer");
    expect(result.authentik_groups).toEqual(["platform-users"]);
    // Stored had no role_assignments, so none are applied — the injected one is gone.
    expect(result.role_assignments).toBeUndefined();
  });

  it("preserves a stored role_assignments list against a request that tries to drop it", () => {
    const stored = { access_level: "admin", role_assignments: [{ id: "ra-1", roleId: "developer", scope: "/" }] };
    const incoming = { name: "Edited" }; // no role_assignments in body
    const result = preservePrivilegedFields(incoming, stored);
    expect(result.role_assignments).toEqual([{ id: "ra-1", roleId: "developer", scope: "/" }]);
    expect(result.access_level).toBe("admin");
  });

  it("applies safe defaults for a brand-new user (no stored record)", () => {
    const incoming = { name: "Newbie", email: "n@x", access_level: "admin", role_assignments: [{ roleId: "platform-owner" }] };
    const result = preservePrivilegedFields(incoming, undefined);
    expect(result.name).toBe("Newbie");
    expect(result.email).toBe("n@x");
    // Cannot self-assign privilege on creation.
    expect(result.access_level).toBe(DEFAULT_USER_PRIVILEGES.access_level);
    expect(result.access_level).toBe("viewer");
    expect(result.role_assignments).toBeUndefined();
    expect(result.authentik_groups).toBeUndefined();
  });

  it("does not mutate the incoming or stored objects (immutability)", () => {
    const stored = Object.freeze({ access_level: "viewer" });
    const incoming = Object.freeze({ name: "X", access_level: "admin" });
    expect(() => preservePrivilegedFields(incoming, stored)).not.toThrow();
    expect((incoming as { access_level: string }).access_level).toBe("admin");
  });
});
