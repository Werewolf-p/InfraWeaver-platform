import {
  computeShareAccessUsers,
  computeStorageAccessUsers,
  listStorageGrantsForScope,
  storageAccessGroupName,
  type AccessGroup,
  type AccessUser,
} from "@/lib/nas/access-policy";
import type { RoleAssignment } from "@/lib/rbac";

function grant(roleId: string, scope: string, over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: `${roleId}@${scope}`,
    roleId,
    scope,
    principalType: "user",
    principalId: "",
    grantedBy: "remon",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const MEDIA = "/nas/truenas/media";

describe("storageAccessGroupName", () => {
  it("derives a stable per-share, per-access Authentik group name", () => {
    expect(storageAccessGroupName("truenas", "media", "readwrite")).toBe("storage-truenas-media-rw");
    expect(storageAccessGroupName("truenas", "media", "readonly")).toBe("storage-truenas-media-ro");
  });

  it("normalizes case so one share maps to exactly one group", () => {
    expect(storageAccessGroupName("TrueNAS", "Media", "readwrite")).toBe("storage-truenas-media-rw");
  });

  it("names a folder scope distinctly from its share", () => {
    // Nextcloud mounts a SUBFOLDER (`/Media` is `media` inside the `infraweaver`
    // share), so the folder must have its own group or a folder-level grantee
    // would never land in the group that reveals the folder.
    const folder = storageAccessGroupName("truenas", "infraweaver", "readwrite", "media");
    expect(folder).toMatch(/^storage-truenas-infraweaver-media-[0-9a-f]{12}-rw$/);
    expect(folder).not.toBe(storageAccessGroupName("truenas", "infraweaver", "readwrite"));
  });

  it("is deterministic across calls", () => {
    expect(storageAccessGroupName("truenas", "media", "readwrite", "movies/4k"))
      .toBe(storageAccessGroupName("truenas", "media", "readwrite", "movies/4k"));
  });

  it("does not collide a nested folder with a sibling whose name is the flattened form", () => {
    // `movies/4k` flattens to `movies-4k`; without the scope hash these two
    // distinct folders would share one access group.
    const nested = storageAccessGroupName("truenas", "media", "readwrite", "movies/4k");
    const sibling = storageAccessGroupName("truenas", "media", "readwrite", "movies-4k");
    expect(nested).not.toBe(sibling);
  });
});

describe("computeStorageAccessUsers", () => {
  const groups: Record<string, AccessGroup> = {};

  it("includes a user granted directly on the scope", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-contributor", MEDIA)] },
    };
    expect(computeStorageAccessUsers(MEDIA, "readwrite", users, groups)).toEqual(["alice"]);
  });

  it("excludes a user with no storage grant at all", () => {
    const users: Record<string, AccessUser> = { bob: {} };
    expect(computeStorageAccessUsers(MEDIA, "readonly", users, groups)).toEqual([]);
  });

  it("separates read-only from read-write", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-contributor", MEDIA)] },
      bob: { role_assignments: [grant("storage-viewer", MEDIA)] },
    };
    expect(computeStorageAccessUsers(MEDIA, "readonly", users, groups)).toEqual(["alice", "bob"]);
    expect(computeStorageAccessUsers(MEDIA, "readwrite", users, groups)).toEqual(["alice"]);
  });

  it("inherits a grant made on an ancestor scope", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-viewer", "/nas/truenas")] },
      carol: { role_assignments: [grant("storage-viewer", "/nas")] },
    };
    expect(computeStorageAccessUsers(`${MEDIA}/movies`, "readonly", users, groups)).toEqual(["alice", "carol"]);
  });

  it("does not leak a grant on a sibling share", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-contributor", "/nas/truenas/media-archive")] },
    };
    expect(computeStorageAccessUsers(MEDIA, "readonly", users, groups)).toEqual([]);
  });

  it("resolves a grant made to a group the user belongs to", () => {
    const users: Record<string, AccessUser> = {
      alice: { authentik_groups: ["media-team"] },
      bob: { authentik_groups: ["other-team"] },
    };
    const withGroup: Record<string, AccessGroup> = {
      "media-team": { role_assignments: [grant("storage-contributor", MEDIA, { principalType: "group", principalId: "media-team" })] },
    };
    expect(computeShareAccessUsers("truenas", "media", "readwrite", users, withGroup)).toEqual(["alice"]);
  });

  it("ignores an expired grant", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-contributor", MEDIA, { expiresAt: "2020-01-01T00:00:00.000Z" })] },
    };
    expect(computeStorageAccessUsers(MEDIA, "readwrite", users, groups)).toEqual([]);
  });

  it("includes the platform owner, who holds `*` and never needs a storage grant", () => {
    const users: Record<string, AccessUser> = {
      remon: { role_assignments: [grant("platform-owner", "/")] },
    };
    expect(computeStorageAccessUsers(`${MEDIA}/finance`, "readwrite", users, groups)).toEqual(["remon"]);
  });
});

describe("listStorageGrantsForScope", () => {
  it("returns direct and inherited grants, flagging which is which", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-contributor", MEDIA)] },
      carol: { role_assignments: [grant("storage-viewer", "/nas/truenas")] },
      dave: { role_assignments: [grant("storage-viewer", "/nas/truenas/backups")] },
    };
    const found = listStorageGrantsForScope(MEDIA, users, {});
    expect(found.map((g) => [g.principalId, g.inherited])).toEqual([
      ["alice", false],
      ["carol", true],
    ]);
  });

  it("attributes a group grant to the group name", () => {
    const found = listStorageGrantsForScope(MEDIA, {}, {
      "media-team": { role_assignments: [grant("storage-contributor", MEDIA, { principalType: "group", principalId: "media-team" })] },
    });
    expect(found).toHaveLength(1);
    expect(found[0].principalType).toBe("group");
    expect(found[0].principalId).toBe("media-team");
  });
});
