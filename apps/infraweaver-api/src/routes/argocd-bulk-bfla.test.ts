import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "../lib/rbac.js";
import type { UserContext } from "../types/index.js";

// The POST /argocd/apps/bulk 'remove' action issues real ArgoCD DELETEs, so the
// handler now requires apps:delete (not just apps:write) for that action. These
// pins guard the premise that fix relies on: operator-tier roles must lack
// apps:delete while admin/owner hold it — otherwise the BFLA guard is a no-op.
const user = (roles: string[]): UserContext =>
  ({ roles, clusterId: "x", sub: "u", email: "u@x", groups: roles }) as unknown as UserContext;

describe("argocd bulk BFLA guard — permission premise", () => {
  it("platform-operator holds apps:write but NOT apps:delete (bulk remove must be blocked)", () => {
    assert.equal(hasPermission(user(["platform-operator"]), "apps:write"), true);
    assert.equal(hasPermission(user(["platform-operator"]), "apps:delete"), false);
  });

  it("platform-users alias also lacks apps:delete", () => {
    assert.equal(hasPermission(user(["platform-users"]), "apps:delete"), false);
  });

  it("platform-admin holds apps:delete (bulk remove allowed)", () => {
    assert.equal(hasPermission(user(["platform-admin"]), "apps:delete"), true);
  });

  it("platform-owner wildcard holds apps:delete", () => {
    assert.equal(hasPermission(user(["platform-owner"]), "apps:delete"), true);
  });
});
