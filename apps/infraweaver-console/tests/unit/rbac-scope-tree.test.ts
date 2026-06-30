import { buildScopeTree, flattenScopeTree } from "@/app/(dashboard)/rbac-viz/scope-tree";
import type { SubjectBinding } from "@/app/(dashboard)/rbac-viz/types";

function binding(roleId: string, scope: string): SubjectBinding {
  return {
    roleId,
    roleName: roleId,
    scope,
    scopeLabel: scope,
    permissions: [],
    sourceLabel: "Direct assignment",
  };
}

describe("buildScopeTree — visualizer scope hierarchy", () => {
  it("returns an empty tree for a subject with no bindings", () => {
    expect(buildScopeTree([])).toEqual([]);
  });

  it("connects a resource grant up to the platform root", () => {
    const [root] = buildScopeTree([binding("reader", "/wordpress/sites/foo")]);
    expect(root.scope).toBe("/");
    const flat = flattenScopeTree([root]).map((n) => n.scope);
    expect(flat).toEqual(["/", "/wordpress", "/wordpress/sites", "/wordpress/sites/foo"]);
  });

  it("places a grant as direct on its own scope and inherited on descendants", () => {
    const roots = buildScopeTree([
      binding("admin", "/wordpress"),
      binding("editor", "/wordpress/sites/foo"),
    ]);
    const byScope = Object.fromEntries(flattenScopeTree(roots).map((n) => [n.scope, n]));

    // admin assigned on /wordpress is direct there...
    expect(byScope["/wordpress"].direct.map((b) => b.roleId)).toEqual(["admin"]);
    // ...and inherited down at the foo resource, alongside foo's own direct editor grant.
    expect(byScope["/wordpress/sites/foo"].direct.map((b) => b.roleId)).toEqual(["editor"]);
    expect(byScope["/wordpress/sites/foo"].inherited.map((g) => g.binding.roleId)).toEqual(["admin"]);
    expect(byScope["/wordpress/sites/foo"].inherited[0].fromLabel).toBe("All WordPress sites");
  });

  it("increments depth down the hierarchy", () => {
    const roots = buildScopeTree([binding("reader", "/wordpress/sites/foo")]);
    const byScope = Object.fromEntries(flattenScopeTree(roots).map((n) => [n.scope, n.depth]));
    expect(byScope["/"]).toBe(0);
    expect(byScope["/wordpress"]).toBe(1);
    expect(byScope["/wordpress/sites/foo"]).toBe(3);
  });
});
