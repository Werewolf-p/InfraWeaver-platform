import {
  EXPIRING_SOON_MS,
  buildAccessMatrix,
  buildScopeAccess,
  grantsToAssignments,
  type MatrixPrincipal,
} from "@/lib/rbac-access-matrix";

// ── What this guards ─────────────────────────────────────────────────────────
// Pure aggregation for the "who has access to what, where" admin surface:
// resolving grants to matrix cells (role names, orphaned + expiring flags),
// scope-first access with direct/inherited classification, and converting
// gathered grants back into RoleAssignments for the permission resolver.

const NOW = Date.parse("2026-07-01T00:00:00.000Z");

function principal(overrides: Partial<MatrixPrincipal> = {}): MatrixPrincipal {
  return {
    principalId: "alice",
    principalType: "user",
    displayName: "Alice",
    secondary: "alice@example.com",
    grants: [],
    ...overrides,
  };
}

describe("buildAccessMatrix", () => {
  it("resolves role metadata and unions scopes with root first", () => {
    const matrix = buildAccessMatrix(
      [
        principal({
          grants: [
            { roleId: "reader", scope: "/", effect: "Allow", source: "Direct" },
            { roleId: "editor", scope: "/wordpress", effect: "Allow", source: "Direct" },
          ],
        }),
      ],
      NOW,
    );
    expect(matrix.scopes[0]).toBe("/");
    expect(matrix.scopes).toContain("/wordpress");
    const cell = matrix.principals[0].cells.find((c) => c.roleId === "reader");
    expect(cell?.roleName).toBe("Reader");
    expect(cell?.orphaned).toBe(false);
  });

  it("flags an unknown role as orphaned", () => {
    const matrix = buildAccessMatrix([principal({ grants: [{ roleId: "ghost-role", scope: "/", effect: "Allow", source: "Direct" }] })], NOW);
    expect(matrix.principals[0].cells[0].orphaned).toBe(true);
  });

  it("keeps a provided display name for non-built-in roles (PIM/custom) without orphaning", () => {
    const matrix = buildAccessMatrix(
      [principal({ grants: [{ roleId: "custom-group:1", roleName: "Custom group: infra", scope: "/", effect: "Allow", source: "Custom group" }] })],
      NOW,
    );
    expect(matrix.principals[0].cells[0].orphaned).toBe(false);
    expect(matrix.principals[0].cells[0].roleName).toBe("Custom group: infra");
  });

  it("marks a grant expiring within the window as expiringSoon", () => {
    const soon = new Date(NOW + EXPIRING_SOON_MS - 1000).toISOString();
    const later = new Date(NOW + EXPIRING_SOON_MS * 4).toISOString();
    const matrix = buildAccessMatrix(
      [
        principal({
          grants: [
            { roleId: "reader", scope: "/", effect: "Allow", source: "Direct", expiresAt: soon },
            { roleId: "editor", scope: "/wordpress", effect: "Allow", source: "Direct", expiresAt: later },
          ],
        }),
      ],
      NOW,
    );
    const soonCell = matrix.principals[0].cells.find((c) => c.roleId === "reader");
    const laterCell = matrix.principals[0].cells.find((c) => c.roleId === "editor");
    expect(soonCell?.expiringSoon).toBe(true);
    expect(laterCell?.expiringSoon).toBe(false);
  });
});

describe("buildScopeAccess", () => {
  const principals = [
    principal({ grants: [{ roleId: "reader", scope: "/", effect: "Allow", source: "Direct" }] }),
    principal({ principalId: "wp-team", principalType: "group", displayName: "wp-team", grants: [{ roleId: "editor", scope: "/wordpress/sites/foo", effect: "Allow", source: "Group assignment" }] }),
  ];

  it("classifies an ancestor grant as inherited and an exact grant as direct", () => {
    const entries = buildScopeAccess(principals, "/wordpress/sites/foo", NOW);
    const alice = entries.find((e) => e.principalId === "alice");
    const team = entries.find((e) => e.principalId === "wp-team");
    expect(alice?.inherited).toBe(true); // "/" grant inherited down
    expect(team?.inherited).toBe(false); // exact grant on the queried scope
  });

  it("excludes expired grants", () => {
    const expired = [principal({ grants: [{ roleId: "reader", scope: "/", effect: "Allow", source: "Direct", expiresAt: "2020-01-01T00:00:00.000Z" }] })];
    expect(buildScopeAccess(expired, "/wordpress", NOW)).toHaveLength(0);
  });

  it("omits principals whose grant does not cover the scope", () => {
    const entries = buildScopeAccess(principals, "/game-hub/servers/x", NOW);
    // Only alice's root grant covers it; wp-team's foo grant does not.
    expect(entries.map((e) => e.principalId)).toEqual(["alice"]);
  });
});

describe("grantsToAssignments", () => {
  it("maps grants into resolver-ready assignments preserving type and effect", () => {
    const assignments = grantsToAssignments(
      principal({
        principalType: "group",
        principalId: "wp-team",
        grants: [{ roleId: "reader", scope: "/wordpress", effect: "Deny", source: "Group assignment" }],
      }),
    );
    expect(assignments[0].principalType).toBe("group");
    expect(assignments[0].principalId).toBe("wp-team");
    expect(assignments[0].effect).toBe("Deny");
  });
});
