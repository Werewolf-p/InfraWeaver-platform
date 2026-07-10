import {
  NAS_SCOPE_ROOT,
  nasAuthorizationScope,
  nasFolderScope,
  nasProviderScope,
  nasShareScope,
  parseNasScope,
} from "@/lib/nas/scope";
import { scopeCovers } from "@/lib/rbac";

describe("NAS scopes", () => {
  it("builds provider, share and folder scopes", () => {
    expect(nasProviderScope("truenas")).toBe("/nas/truenas");
    expect(nasShareScope("truenas", "media")).toBe("/nas/truenas/media");
    expect(nasFolderScope("truenas", "media", "movies/4k")).toBe("/nas/truenas/media/movies/4k");
  });

  it("normalizes case so scopes match the RBAC scope grammar", () => {
    // `/^\/(|[a-z0-9/_-]+)$/` in the assignments API rejects uppercase, and SMB
    // shares are case-insensitive, so a scope must be lowercase to be grantable.
    expect(nasShareScope("TrueNAS", "Media")).toBe("/nas/truenas/media");
    expect(nasFolderScope("truenas", "media", "Movies/4K")).toBe("/nas/truenas/media/movies/4k");
  });

  it("treats an empty subfolder as the share scope", () => {
    expect(nasFolderScope("truenas", "media", "")).toBe("/nas/truenas/media");
    expect(nasFolderScope("truenas", "media")).toBe("/nas/truenas/media");
    expect(nasFolderScope("truenas", "media", "/")).toBe("/nas/truenas/media");
  });

  it("strips leading and trailing slashes from the subfolder", () => {
    expect(nasFolderScope("truenas", "media", "/movies/")).toBe("/nas/truenas/media/movies");
  });

  it("inherits: a share grant covers every folder beneath it", () => {
    const share = nasShareScope("truenas", "media");
    expect(scopeCovers(share, nasFolderScope("truenas", "media", "movies"))).toBe(true);
    expect(scopeCovers(share, nasFolderScope("truenas", "media", "movies/4k"))).toBe(true);
  });

  it("does not leak across sibling shares with a shared prefix", () => {
    // scopeCovers is boundary-aware: `/nas/truenas/media` must not cover
    // `/nas/truenas/media-archive`.
    const share = nasShareScope("truenas", "media");
    expect(scopeCovers(share, nasShareScope("truenas", "media-archive"))).toBe(false);
    expect(scopeCovers(share, nasFolderScope("truenas", "media2", "x"))).toBe(false);
  });

  it("a folder grant does not confer access to its parent share", () => {
    const folder = nasFolderScope("truenas", "media", "movies");
    expect(scopeCovers(folder, nasShareScope("truenas", "media"))).toBe(false);
  });

  it("round-trips through parseNasScope", () => {
    expect(parseNasScope("/nas/truenas/media/movies/4k")).toEqual({
      provider: "truenas",
      share: "media",
      subfolder: "movies/4k",
    });
    expect(parseNasScope("/nas/truenas/media")).toEqual({
      provider: "truenas",
      share: "media",
      subfolder: "",
    });
  });

  it("parseNasScope rejects scopes outside the NAS subtree or missing a share", () => {
    expect(parseNasScope("/wordpress/sites/blog")).toBeNull();
    expect(parseNasScope(NAS_SCOPE_ROOT)).toBeNull();
    expect(parseNasScope("/nas/truenas")).toBeNull();
    expect(parseNasScope("/")).toBeNull();
  });

  it("rejects path traversal in the subfolder rather than emitting a climbing scope", () => {
    expect(() => nasFolderScope("truenas", "media", "../../etc")).toThrow();
    expect(() => nasFolderScope("truenas", "media", "movies/../../../root")).toThrow();
  });

  it("rejects characters the RBAC scope grammar would reject", () => {
    expect(() => nasFolderScope("truenas", "media", "a b")).toThrow();
    expect(() => nasFolderScope("true nas", "media", "")).toThrow();
    expect(() => nasShareScope("truenas", "me:dia")).toThrow();
  });
});

describe("nasAuthorizationScope", () => {
  it("matches nasFolderScope when every segment is addressable", () => {
    expect(nasAuthorizationScope("truenas", "media", "movies/4k")).toBe("/nas/truenas/media/movies/4k");
    expect(nasAuthorizationScope("truenas", "media", "")).toBe("/nas/truenas/media");
  });

  it("falls back to the deepest addressable ancestor for an unaddressable folder", () => {
    // Real media libraries are full of these. A grant on the share must still
    // reach them, because grants inherit downwards.
    expect(nasAuthorizationScope("truenas", "media", "Season.01")).toBe("/nas/truenas/media");
    expect(nasAuthorizationScope("truenas", "media", "movies/Movie.2024")).toBe("/nas/truenas/media/movies");
    expect(nasAuthorizationScope("truenas", "media", "The Wire/S01")).toBe("/nas/truenas/media");
  });

  it("stops at the FIRST unaddressable segment, never resuming below it", () => {
    // `/nas/truenas/media/movies` would be wrong here: the caller asked for a
    // path under `Movie.2024`, and resuming would authorize them at a scope that
    // is not an ancestor of what they asked for.
    expect(nasAuthorizationScope("truenas", "media", "Movie.2024/movies")).toBe("/nas/truenas/media");
  });

  it("lowercases addressable segments just like nasFolderScope", () => {
    expect(nasAuthorizationScope("truenas", "media", "Movies/4K")).toBe("/nas/truenas/media/movies/4k");
  });

  it("never returns a scope outside the folder's own ancestor chain", () => {
    // The security property: whatever it returns must COVER the strict scope of
    // the requested folder when that scope exists, i.e. be an ancestor of it.
    const strict = nasFolderScope("truenas", "media", "movies/4k");
    expect(scopeCovers(nasAuthorizationScope("truenas", "media", "movies/4k"), strict)).toBe(true);
  });

  it("throws only when the provider or share themselves are unaddressable", () => {
    expect(() => nasAuthorizationScope("true nas", "media", "x")).toThrow();
    expect(() => nasAuthorizationScope("truenas", "me:dia", "x")).toThrow();
  });
});
