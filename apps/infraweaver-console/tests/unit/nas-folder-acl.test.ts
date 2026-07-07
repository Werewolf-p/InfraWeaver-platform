import { evaluateFolderAcl, listFolderAclRules, resetFolderAclRegistry } from "@/lib/nas/folder-acl";

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
