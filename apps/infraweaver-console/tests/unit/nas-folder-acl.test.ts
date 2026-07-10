import { evaluateFolderAcl, listFolderAclRules, resetFolderAclRegistry } from "@/lib/nas/folder-acl";
import type { RoleAssignment } from "@/lib/rbac";

function assignment(over: Partial<RoleAssignment> & Pick<RoleAssignment, "roleId" | "scope">): RoleAssignment {
  return {
    id: `a-${over.roleId}-${over.scope}`,
    principalType: "user",
    principalId: "alice",
    grantedBy: "remon",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function withAcl(json: unknown, groups: string[], access: "readonly" | "readwrite", overrides: Partial<{ provider: string; share: string; subfolder: string; username: string; permissions: string[] }> = {}) {
  return evaluateFolderAcl(
    {
      username: overrides.username ?? "alice",
      groups,
      permissions: overrides.permissions ?? ["nas:write"],
      provider: overrides.provider ?? "synology",
      share: overrides.share ?? "media",
      subfolder: overrides.subfolder ?? "movies",
      access,
    },
    { NAS_FOLDER_ACL_JSON: JSON.stringify(json) } as NodeJS.ProcessEnv,
  );
}

describe("NAS folder ACL", () => {
  beforeEach(() => resetFolderAclRegistry());

  it("permits everything when no ACL is configured (backwards compatible)", () => {
    const decision = evaluateFolderAcl(
      { username: "alice", groups: [], permissions: ["nas:write"], provider: "synology", share: "media", subfolder: "movies", access: "readwrite" },
      {} as NodeJS.ProcessEnv,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-acl-configured");
  });

  it("grants a member of the allow-listed group", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: ["nc-media-ro"], readwrite: ["nc-media-rw"] } }],
      ["nc-media-rw"],
      "readwrite",
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies a caller with no matching group", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: ["nc-media-ro"], readwrite: ["nc-media-rw"] } }],
      ["random-group"],
      "readwrite",
    );
    expect(decision.allowed).toBe(false);
  });

  it("RW grant implies RO", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: [], readwrite: ["nc-media-rw"] } }],
      ["nc-media-rw"],
      "readonly",
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies RW when only RO is granted", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: ["nc-media-ro"], readwrite: [] } }],
      ["nc-media-ro"],
      "readwrite",
    );
    expect(decision.allowed).toBe(false);
  });

  it("supports subfolder_prefix scoping (grants inside, denies outside)", () => {
    const acl = [
      { provider: "synology", share: "media", subfolder_prefix: "movies/", allow: { readonly: ["nc-movies"], readwrite: ["nc-movies"] } },
    ];
    expect(withAcl(acl, ["nc-movies"], "readonly", { subfolder: "movies/kids" }).allowed).toBe(true);
    // Outside prefix but same restricted share → default-deny.
    expect(withAcl(acl, ["nc-movies"], "readonly", { subfolder: "finance" }).allowed).toBe(false);
  });

  it("supports wildcard provider and share", () => {
    const decision = withAcl(
      [{ provider: "*", share: "*", allow: { readonly: ["everyone"], readwrite: [] } }],
      ["everyone"],
      "readonly",
      { provider: "truenas", share: "backups" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("owner (`*` permission) bypasses ACL", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: [], readwrite: [] } }],
      [],
      "readwrite",
      { permissions: ["*"] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("owner-bypass");
  });

  it("`@user:<name>` grants a specific user without a group", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: [], readwrite: ["@user:alice"] } }],
      [],
      "readwrite",
      { username: "alice" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("`*` in allow list grants any authenticated caller", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: ["*"], readwrite: [] } }],
      [],
      "readonly",
    );
    expect(decision.allowed).toBe(true);
  });

  it("shares with no rule at all remain open (opt-in tightening)", () => {
    const decision = withAcl(
      [{ provider: "synology", share: "media", allow: { readonly: ["nc-media-ro"], readwrite: [] } }],
      [],
      "readwrite",
      { share: "public-drop", subfolder: "" },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("share-not-restricted");
  });

  it("fails closed on malformed NAS_FOLDER_ACL_JSON", () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rules = listFolderAclRules({ NAS_FOLDER_ACL_JSON: "not-json" } as NodeJS.ProcessEnv);
      // A single deny-all rule is installed.
      expect(rules).toHaveLength(1);
      expect(rules[0].allow.readonly).toEqual([]);
      expect(rules[0].allow.readwrite).toEqual([]);
      const decision = evaluateFolderAcl(
        { username: "alice", groups: ["anything"], permissions: ["nas:write"], provider: "synology", share: "media", subfolder: "", access: "readonly" },
        { NAS_FOLDER_ACL_JSON: "not-json" } as NodeJS.ProcessEnv,
      );
      expect(decision.allowed).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("NAS folder ACL — scoped RBAC grants", () => {
  beforeEach(() => resetFolderAclRegistry());

  const noEnv = {} as NodeJS.ProcessEnv;
  const base = {
    username: "alice",
    groups: [] as string[],
    permissions: [] as string[],
    provider: "truenas",
    share: "media",
    subfolder: "movies",
  };

  it("grants read-write from a storage-contributor assignment on the share", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        access: "readwrite",
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media" })],
      },
      noEnv,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("rbac-grant");
  });

  it("a share grant inherits down to nested folders", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        subfolder: "movies/4k/hdr",
        access: "readwrite",
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media" })],
      },
      noEnv,
    );
    expect(decision.allowed).toBe(true);
  });

  it("a folder grant does not confer access to a sibling folder", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        subfolder: "finance",
        access: "readonly",
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media/movies" })],
      },
      noEnv,
    );
    expect(decision.allowed).toBe(false);
  });

  it("a grant on one share never leaks into a prefix-sharing sibling share", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        share: "media-archive",
        subfolder: "",
        access: "readonly",
        roleAssignments: [assignment({ roleId: "storage-viewer", scope: "/nas/truenas/media" })],
      },
      noEnv,
    );
    expect(decision.allowed).toBe(false);
  });

  it("storage-viewer grants readonly but not readwrite", () => {
    const grant = [assignment({ roleId: "storage-viewer", scope: "/nas/truenas/media" })];
    expect(evaluateFolderAcl({ ...base, access: "readonly", roleAssignments: grant }, noEnv).allowed).toBe(true);
    expect(evaluateFolderAcl({ ...base, access: "readwrite", roleAssignments: grant }, noEnv).allowed).toBe(false);
  });

  it("an expired assignment grants nothing", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        access: "readwrite",
        roleAssignments: [
          assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media", expiresAt: "2020-01-01T00:00:00.000Z" }),
        ],
      },
      noEnv,
    );
    expect(decision.allowed).toBe(false);
  });

  it("a scoped grant overrides a restrictive legacy env ACL", () => {
    // The env ACL restricts truenas/media to a group alice is not in, but she
    // holds an explicit, audited, scoped grant. The grant wins.
    const decision = evaluateFolderAcl(
      {
        ...base,
        access: "readwrite",
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media" })],
      },
      {
        NAS_FOLDER_ACL_JSON: JSON.stringify([
          { provider: "truenas", share: "media", allow: { readonly: ["someone-else"], readwrite: [] } },
        ]),
      } as NodeJS.ProcessEnv,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("rbac-grant");
  });

  it("falls through to the legacy env ACL when no scoped grant matches", () => {
    const decision = evaluateFolderAcl(
      {
        ...base,
        groups: ["nc-media-rw"],
        permissions: ["nas:write"],
        access: "readwrite",
        roleAssignments: [assignment({ roleId: "storage-viewer", scope: "/nas/truenas/other" })],
      },
      {
        NAS_FOLDER_ACL_JSON: JSON.stringify([
          { provider: "truenas", share: "media", allow: { readonly: [], readwrite: ["nc-media-rw"] } },
        ]),
      } as NodeJS.ProcessEnv,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("granted");
  });

  it("a folder whose name is not scope-addressable inherits from its nearest addressable ancestor", () => {
    // `Movies & TV` cannot be an RBAC scope segment, but a grant on the share
    // covers everything beneath it. Denying here would hide most of a real media
    // library from the very people granted it.
    const decision = evaluateFolderAcl(
      {
        ...base,
        subfolder: "Movies & TV",
        access: "readwrite",
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/media" })],
      },
      {
        NAS_FOLDER_ACL_JSON: JSON.stringify([
          { provider: "truenas", share: "media", allow: { readonly: [], readwrite: [] } },
        ]),
      } as NodeJS.ProcessEnv,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("rbac-grant");
  });

  it("an unaddressable folder never auto-allows a caller with no covering grant", () => {
    // The property the previous test protects must not become a bypass: with no
    // grant that covers the ancestor, the legacy rules decide, and they deny.
    const decision = evaluateFolderAcl(
      {
        ...base,
        subfolder: "Movies & TV",
        access: "readwrite",
        permissions: ["nas:write"],
        roleAssignments: [assignment({ roleId: "storage-contributor", scope: "/nas/truenas/other" })],
      },
      {
        NAS_FOLDER_ACL_JSON: JSON.stringify([
          { provider: "truenas", share: "media", allow: { readonly: [], readwrite: [] } },
        ]),
      } as NodeJS.ProcessEnv,
    );
    expect(decision.allowed).toBe(false);
  });

  it("owner bypass still wins over everything", () => {
    const decision = evaluateFolderAcl(
      { ...base, permissions: ["*"], access: "readwrite", roleAssignments: [] },
      noEnv,
    );
    expect(decision.reason).toBe("owner-bypass");
  });
});
