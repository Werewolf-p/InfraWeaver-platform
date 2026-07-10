// Guards the storage authorization boundary.
//
// Before scoped storage grants existed, every NAS route gated on
// `hasSessionPermission(rbac, "nas:read")` — evaluated at the ROOT scope — so a
// user granted one share was rejected at the door and the folder ACL never ran.
// Admission is now coarse ("holds nas:* anywhere under /nas") and every share
// and folder in the response is authorized against its own scope.
//
// The failure this file exists to prevent: a scope-granted user falling through
// to the legacy ACL's "no rules configured → allow" default and thereby reaching
// every OTHER share on the appliance.

jest.mock("server-only", () => ({}), { virtual: true });
// `session-rbac` pulls in the Kubernetes client (ESM) and the git-backed users
// config purely to BUILD a session context. The functions under test only read
// an already-built context, so stub the loaders out; the real RBAC resolver and
// the real folder ACL stay in play, which is the point of these tests.
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/users-config", () => ({
  getRoleAssignmentsForSession: jest.fn(),
  getGroupRoleAssignmentsForSession: jest.fn(),
}));

import {
  canAccessNasFolder,
  canReadStorage,
  canTraverseNasFolder,
  canWriteStorage,
  visibleFolders,
} from "@/lib/nas/authz";
import type { RoleAssignment } from "@/lib/rbac";
import type { SessionRBACContext } from "@/lib/session-rbac";

function grant(roleId: string, scope: string, over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: `${roleId}@${scope}`,
    roleId,
    scope,
    principalType: "user",
    principalId: "alice",
    grantedBy: "remon",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function ctx(over: Partial<SessionRBACContext> = {}): SessionRBACContext {
  return { groups: [], username: "alice", roleAssignments: [], extraPermissions: [], ...over };
}

/** Only a grant on `/nas/truenas/media` — no blanket nas:* anywhere. */
const scopedUser = ctx({ roleAssignments: [grant("storage-contributor", "/nas/truenas/media")] });
/** Platform owner: "*" at the root. */
const owner = ctx({ username: "remon", roleAssignments: [grant("platform-owner", "/")] });
/** Blanket nas:read + nas:write, no storage grants (platform-admin shape). */
const admin = ctx({ username: "admin", roleAssignments: [grant("platform-admin", "/")] });
/** Signed in, no storage authority at all. */
const stranger = ctx({ username: "mallory" });

const MEDIA = { provider: "truenas", share: "media" };

describe("storage admission", () => {
  it("admits the platform owner", () => {
    expect(canReadStorage(owner)).toBe(true);
    expect(canWriteStorage(owner)).toBe(true);
  });

  it("admits a user whose only authority is one scoped grant", () => {
    // This is the case the old root-scope guard rejected outright.
    expect(canReadStorage(scopedUser)).toBe(true);
    expect(canWriteStorage(scopedUser)).toBe(true);
  });

  it("admits a read-only scoped user to read but not to write", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media")] });
    expect(canReadStorage(viewer)).toBe(true);
    expect(canWriteStorage(viewer)).toBe(false);
  });

  it("refuses a user with no storage authority", () => {
    expect(canReadStorage(stranger)).toBe(false);
    expect(canWriteStorage(stranger)).toBe(false);
  });
});

describe("per-folder decisions", () => {
  it("the platform owner reaches every folder with no grants at all", () => {
    expect(canAccessNasFolder(owner, { ...MEDIA, subfolder: "finance", access: "readwrite" })).toBe(true);
    expect(canAccessNasFolder(owner, { provider: "synology", share: "anything", subfolder: "", access: "readwrite" })).toBe(true);
  });

  it("a scoped grant reaches its own subtree", () => {
    expect(canAccessNasFolder(scopedUser, { ...MEDIA, subfolder: "", access: "readwrite" })).toBe(true);
    expect(canAccessNasFolder(scopedUser, { ...MEDIA, subfolder: "movies/4k", access: "readwrite" })).toBe(true);
  });

  it("a scoped grant does NOT reach a different share, even with no legacy ACL configured", () => {
    // The regression that matters. `evaluateFolderAcl`'s legacy default is
    // "no rules → allow"; a scope-granted user must never fall through to it.
    expect(canAccessNasFolder(scopedUser, { provider: "truenas", share: "finance", subfolder: "", access: "readonly" })).toBe(false);
    expect(canAccessNasFolder(scopedUser, { provider: "truenas", share: "finance", subfolder: "", access: "readwrite" })).toBe(false);
  });

  it("a scoped grant does not leak into a prefix-sharing sibling share", () => {
    expect(canAccessNasFolder(scopedUser, { provider: "truenas", share: "media-archive", subfolder: "", access: "readonly" })).toBe(false);
  });

  it("a scoped grant does not reach another provider", () => {
    expect(canAccessNasFolder(scopedUser, { provider: "synology", share: "media", subfolder: "", access: "readonly" })).toBe(false);
  });

  it("a blanket nas:* admin reaches folders when no legacy ACL restricts them", () => {
    expect(canAccessNasFolder(admin, { ...MEDIA, subfolder: "finance", access: "readwrite" })).toBe(true);
  });
});

describe("folders whose names are not scope-addressable", () => {
  // `Season.01` cannot be an RBAC scope segment (the grammar is [a-z0-9_-]).
  // Grants inherit downwards, so a Contributor on the share must still reach it;
  // evaluating it strictly would hide most of a real media library.
  it("a share grant reaches a dotted child folder", () => {
    expect(canAccessNasFolder(scopedUser, { ...MEDIA, subfolder: "Season.01", access: "readwrite" })).toBe(true);
    expect(canAccessNasFolder(scopedUser, { ...MEDIA, subfolder: "movies/Movie.2024", access: "readwrite" })).toBe(true);
    expect(canAccessNasFolder(scopedUser, { ...MEDIA, subfolder: "The Wire/S01", access: "readonly" })).toBe(true);
  });

  it("the fallback confers nothing the ancestor did not already confer", () => {
    // Granted only on `media/movies`. A dotted folder in a SIBLING subtree still
    // resolves to an ancestor the grant does not cover, so it stays denied.
    const narrow = ctx({ roleAssignments: [grant("storage-contributor", "/nas/truenas/media/movies")] });
    expect(canAccessNasFolder(narrow, { ...MEDIA, subfolder: "movies/Movie.2024", access: "readwrite" })).toBe(true);
    expect(canAccessNasFolder(narrow, { ...MEDIA, subfolder: "finance/Q1.2026", access: "readonly" })).toBe(false);
    expect(canAccessNasFolder(narrow, { ...MEDIA, subfolder: "Season.01", access: "readonly" })).toBe(false);
  });

  it("a dotted segment does not let a deeper path resume matching", () => {
    // Granted on `media/movies`. Asking for `media/Movie.2024/movies` must not
    // authorize at `media/movies` just because the leaf spells the same word.
    const narrow = ctx({ roleAssignments: [grant("storage-contributor", "/nas/truenas/media/movies")] });
    expect(canAccessNasFolder(narrow, { ...MEDIA, subfolder: "Movie.2024/movies", access: "readonly" })).toBe(false);
  });

  it("a read-only grant on the share still cannot write a dotted child", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media")] });
    expect(canAccessNasFolder(viewer, { ...MEDIA, subfolder: "Season.01", access: "readonly" })).toBe(true);
    expect(canAccessNasFolder(viewer, { ...MEDIA, subfolder: "Season.01", access: "readwrite" })).toBe(false);
  });
});

describe("listing filters", () => {
  it("hides sibling folders a scoped user cannot read", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media/movies")] });
    const listed = [{ name: "movies" }, { name: "finance" }, { name: "photos" }];
    expect(visibleFolders(viewer, "truenas", "media", "", listed).map((f) => f.name)).toEqual(["movies"]);
  });

  it("shows every folder to the platform owner", () => {
    const listed = [{ name: "movies" }, { name: "finance" }];
    expect(visibleFolders(owner, "truenas", "media", "", listed)).toHaveLength(2);
  });

  it("filters nested listings against the full path, not the leaf name", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media/movies/4k")] });
    const listed = [{ name: "4k" }, { name: "sd" }];
    expect(visibleFolders(viewer, "truenas", "media", "movies", listed).map((f) => f.name)).toEqual(["4k"]);
  });
});

describe("traversal", () => {
  it("lets a user granted a deep folder open its ancestors to get there", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media/movies/4k")] });
    // Cannot READ the share root...
    expect(canAccessNasFolder(viewer, { ...MEDIA, subfolder: "", access: "readonly" })).toBe(false);
    // ...but may traverse it, and `movies`, to reach the grant.
    expect(canTraverseNasFolder(viewer, { ...MEDIA, subfolder: "" })).toBe(true);
    expect(canTraverseNasFolder(viewer, { ...MEDIA, subfolder: "movies" })).toBe(true);
    expect(canTraverseNasFolder(viewer, { ...MEDIA, subfolder: "movies/4k" })).toBe(true);
  });

  it("does not let traversal reach a folder off the granted path", () => {
    const viewer = ctx({ roleAssignments: [grant("storage-viewer", "/nas/truenas/media/movies/4k")] });
    expect(canTraverseNasFolder(viewer, { ...MEDIA, subfolder: "finance" })).toBe(false);
    expect(canTraverseNasFolder(viewer, { provider: "truenas", share: "finance", subfolder: "" })).toBe(false);
  });

  it("refuses traversal to a user with no storage authority", () => {
    expect(canTraverseNasFolder(stranger, { ...MEDIA, subfolder: "" })).toBe(false);
  });
});
