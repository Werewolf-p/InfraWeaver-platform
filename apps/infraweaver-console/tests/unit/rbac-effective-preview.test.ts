// Pure model behind the settings/rbac "effective access preview". Given the
// current assignments plus the client-side staged edits (grants to add, ids to
// revoke), it derives — PER affected principal — the humanized rights they will
// hold AFTER Apply, honoring Azure-style Deny and expiry exactly as the real
// permission resolver does. These are unit-tested directly (no DOM) so the UI
// can stay a thin renderer over this.

import {
  computeEffectivePreview,
  humanizePermissions,
  type PreviewAssignment,
  type StagedGrantInput,
} from "@/lib/rbac-effective-preview";
import type { RoleAssignment } from "@/lib/rbac";

const NOW = Date.parse("2026-07-11T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function existing(over: Partial<PreviewAssignment> = {}): PreviewAssignment {
  return {
    id: "a1",
    roleId: "reader" as RoleAssignment["roleId"],
    scope: "/",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: "2026-07-01T00:00:00.000Z",
    principal: "alice",
    principalLabel: "Alice",
    ...over,
  };
}

function staged(over: Partial<StagedGrantInput> = {}): StagedGrantInput {
  return {
    principalType: "user",
    principal: "bob",
    principalLabel: "Bob",
    roleId: "reader",
    scope: "/",
    ...over,
  };
}

describe("humanizePermissions", () => {
  it("collapses the owner wildcard to a single full-access line", () => {
    const rights = humanizePermissions(["*"]);
    expect(rights).toHaveLength(1);
    expect(rights[0].tone).toBe("allow");
    expect(rights[0].label).toMatch(/full owner access/i);
  });

  it("says View when a resource has only read", () => {
    expect(humanizePermissions(["apps:read"])).toEqual([
      expect.objectContaining({ label: "View apps", tone: "allow" }),
    ]);
  });

  it("says Manage when a resource has any mutating verb, as one line", () => {
    const rights = humanizePermissions(["game-hub:read", "game-hub:start", "game-hub:stop"]);
    expect(rights).toEqual([expect.objectContaining({ label: "Manage game servers" })]);
  });

  it("sorts multiple resources for a stable read-out", () => {
    const rights = humanizePermissions(["wiki:read", "apps:read"]);
    expect(rights.map((r) => r.label)).toEqual(["View apps", "View the wiki"]);
  });

  it("gives each right a stable, unique key", () => {
    const rights = humanizePermissions(["apps:read", "wiki:read"]);
    const keys = rights.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("computeEffectivePreview", () => {
  it("returns only principals touched by a staged edit", () => {
    const out = computeEffectivePreview({
      assignments: [existing({ principal: "alice" })], // untouched
      pendingGrants: [staged({ principal: "bob", principalLabel: "Bob" })],
      revokedIds: [],
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].principal).toBe("bob");
    expect(out[0].key).toBe("user:bob");
  });

  it("marks a fresh grant as a net gain with an added grant row", () => {
    const [p] = computeEffectivePreview({
      assignments: [],
      pendingGrants: [staged({ roleId: "reader", scope: "/" })],
      revokedIds: [],
      now: NOW,
    });
    expect(p.net).toBe("gain");
    expect(p.grants).toHaveLength(1);
    expect(p.grants[0]).toMatchObject({ state: "added", roleName: "Reader", effect: "Allow", scopeLabel: "Cluster-wide" });
    expect(p.rights.some((r) => r.label === "View apps" && r.tone === "allow")).toBe(true);
  });

  it("marks a revoke as a net loss that clears the resulting rights", () => {
    const [p] = computeEffectivePreview({
      assignments: [existing({ id: "a1", roleId: "editor", principal: "alice" })],
      pendingGrants: [],
      revokedIds: ["a1"],
      now: NOW,
    });
    expect(p.net).toBe("loss");
    expect(p.grants[0].state).toBe("removed");
    expect(p.rights).toHaveLength(0);
  });

  it("surfaces a Deny grant as a scoped 'Cannot' right", () => {
    const [p] = computeEffectivePreview({
      assignments: [
        existing({ id: "d1", roleId: "editor", scope: "/game-hub/servers/foo", effect: "Deny", principal: "alice" }),
      ],
      // stage an unrelated allow so alice is an affected principal
      pendingGrants: [staged({ principal: "alice", principalLabel: "Alice", roleId: "reader", scope: "/" })],
      revokedIds: [],
      now: NOW,
    });
    const deny = p.rights.find((r) => r.tone === "deny" && /cannot manage game servers/i.test(r.label));
    expect(deny).toBeDefined();
    expect(deny?.scopeLabel).toBe("Server: foo");
  });

  it("keeps cluster-wide reads that a server-scoped Deny does not cover", () => {
    // A Deny scoped to one game server must not strip reads a root grant confers
    // elsewhere — the enforcing resolver subtracts a Deny only where it covers.
    const [p] = computeEffectivePreview({
      assignments: [
        existing({ id: "read", roleId: "reader", scope: "/", principal: "alice" }),
        existing({ id: "deny", roleId: "editor", scope: "/game-hub/servers/foo", effect: "Deny", principal: "alice" }),
      ],
      pendingGrants: [staged({ principal: "alice", principalLabel: "Alice", roleId: "reader", scope: "/wiki" })],
      revokedIds: [],
      now: NOW,
    });
    // Reads survive at root even though editor(read) is denied at the server scope.
    expect(p.rights.some((r) => r.tone === "allow" && r.label === "View apps")).toBe(true);
    // …and the scoped denial is still surfaced as a caveat.
    expect(p.rights.some((r) => r.tone === "deny" && r.scopeLabel === "Server: foo")).toBe(true);
  });

  it("honors expiry: an expired grant confers nothing, a soon-expiring one is flagged", () => {
    const [p] = computeEffectivePreview({
      assignments: [
        existing({ id: "gone", roleId: "owner", scope: "/", expiresAt: new Date(NOW - DAY).toISOString(), principal: "alice" }),
        existing({ id: "soon", roleId: "reader", scope: "/", expiresAt: new Date(NOW + 2 * DAY).toISOString(), principal: "alice" }),
      ],
      pendingGrants: [staged({ principal: "alice", principalLabel: "Alice", roleId: "reader", scope: "/wiki" })],
      revokedIds: [],
      now: NOW,
    });
    // expired owner must NOT grant full access
    expect(p.rights.some((r) => /full owner access/i.test(r.label))).toBe(false);
    expect(p.hasExpiry).toBe(true);
    expect(p.expiringSoon).toBe(true);
  });

  it("includes rights from a scoped grant that does not cover root", () => {
    const [p] = computeEffectivePreview({
      assignments: [],
      pendingGrants: [staged({ roleId: "game-server-admin", scope: "/game-hub/servers/foo" })],
      revokedIds: [],
      now: NOW,
    });
    expect(p.rights.some((r) => r.label === "Manage game servers" && r.tone === "allow")).toBe(true);
  });

  it("keys group principals distinctly and defaults their grants to Allow", () => {
    const [p] = computeEffectivePreview({
      assignments: [],
      pendingGrants: [staged({ principalType: "group", principal: "media-team", principalLabel: "media-team", roleId: "reader", scope: "/" })],
      revokedIds: [],
      now: NOW,
    });
    expect(p.key).toBe("group:media-team");
    expect(p.principalType).toBe("group");
    expect(p.grants[0].effect).toBe("Allow");
  });

  it("reports mixed when a swap both adds and removes capabilities", () => {
    const [p] = computeEffectivePreview({
      assignments: [existing({ id: "old", roleId: "game-server-admin", scope: "/game-hub/servers/foo", principal: "alice" })],
      pendingGrants: [staged({ principal: "alice", principalLabel: "Alice", roleId: "wordpress-viewer", scope: "/wordpress" })],
      revokedIds: ["old"],
      now: NOW,
    });
    expect(p.net).toBe("mixed");
  });
});
