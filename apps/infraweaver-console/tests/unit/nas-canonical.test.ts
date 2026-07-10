// Guards a HIGH from the adversarial review: RBAC scopes are lowercase, but the
// TrueNAS/Synology filesystem APIs are case-sensitive, so `media` and `Media` can
// be two distinct directories collapsing to one scope. A grant on one would
// authorize the other.
//
// The invariant: a path segment is usable only when exactly one on-disk entry
// matches it case-insensitively. New ambiguity cannot be created; existing
// ambiguity fails closed.

jest.mock("server-only", () => ({}), { virtual: true });

const listNasFolders = jest.fn();
jest.mock("@/lib/nas/folders", () => ({
  listNasFolders: (...args: unknown[]) => listNasFolders(...args),
}));

import {
  NasAmbiguousPathError,
  collidesWithSibling,
  findCaseCollisions,
  resolveCanonicalSubfolder,
  withoutAmbiguousEntries,
} from "@/lib/nas/canonical";

const target = { kind: "truenas", host: "nas.local", port: 443 } as never;
const creds = { apiKey: "k" } as never;

/** Directory tree fixture: parent path -> child names. */
function mockTree(tree: Record<string, string[]>) {
  listNasFolders.mockImplementation((_t, _c, _share, parent: string) =>
    Promise.resolve((tree[parent] ?? []).map((name) => ({ name, subfolder: parent ? `${parent}/${name}` : name }))),
  );
}

beforeEach(() => listNasFolders.mockReset());

describe("findCaseCollisions", () => {
  it("finds names differing only by case", () => {
    expect(findCaseCollisions(["media", "Media", "movies"])).toEqual([["media", "Media"]]);
  });

  it("returns nothing when every name is distinct case-insensitively", () => {
    expect(findCaseCollisions(["media", "movies", "Photos"])).toEqual([]);
  });

  it("groups more than two colliders together", () => {
    expect(findCaseCollisions(["a", "A", "aA"])).toEqual([["a", "A"]]);
  });
});

describe("withoutAmbiguousEntries", () => {
  it("withholds every member of a collision, not just the duplicate", () => {
    // Keeping either one would silently pick a directory for the operator.
    const { kept, ambiguous } = withoutAmbiguousEntries([{ name: "Media" }, { name: "media" }, { name: "movies" }]);
    expect(kept.map((e) => e.name)).toEqual(["movies"]);
    expect(ambiguous).toEqual(["Media", "media"]);
  });

  it("passes an unambiguous listing through untouched", () => {
    const { kept, ambiguous } = withoutAmbiguousEntries([{ name: "movies" }, { name: "photos" }]);
    expect(kept).toHaveLength(2);
    expect(ambiguous).toEqual([]);
  });
});

describe("collidesWithSibling", () => {
  it("detects a case-variant sibling", () => {
    expect(collidesWithSibling("Media", ["media", "movies"])).toBe("media");
  });

  it("an exact match is not a collision (that is just 'already exists')", () => {
    expect(collidesWithSibling("media", ["media"])).toBeNull();
  });

  it("returns null when nothing collides", () => {
    expect(collidesWithSibling("photos", ["media", "movies"])).toBeNull();
  });
});

describe("resolveCanonicalSubfolder", () => {
  it("returns the on-disk casing for a differently-cased request", () => {
    mockTree({ "": ["Movies"], "Movies": ["4K"] });
    return expect(resolveCanonicalSubfolder(target, creds, "media", "movies/4k")).resolves.toBe("Movies/4K");
  });

  it("throws on an ambiguous segment rather than picking one", () => {
    // The exploit: a grant on scope `/nas/truenas/media` must not silently
    // resolve to whichever of `Media`/`media` the appliance lists first.
    mockTree({ "": ["Media", "media"] });
    return expect(resolveCanonicalSubfolder(target, creds, "share", "media")).rejects.toThrow(NasAmbiguousPathError);
  });

  it("throws when the ambiguity is at a deeper segment", () => {
    mockTree({ "": ["movies"], "movies": ["4K", "4k"] });
    return expect(resolveCanonicalSubfolder(target, creds, "media", "movies/4k")).rejects.toThrow(/ambiguous/i);
  });

  it("names the colliding candidates in the error", async () => {
    mockTree({ "": ["Media", "media"] });
    await expect(resolveCanonicalSubfolder(target, creds, "share", "media")).rejects.toThrow(/'Media' and 'media'/);
  });

  it("the share root is always unambiguous", () => {
    mockTree({});
    return expect(resolveCanonicalSubfolder(target, creds, "media", "")).resolves.toBe("");
  });

  it("allows a non-existent leaf when the caller is about to create it", () => {
    mockTree({ "": ["Movies"], "Movies": [] });
    return expect(
      resolveCanonicalSubfolder(target, creds, "media", "movies/new", { mustExist: false }),
    ).resolves.toBe("Movies/new");
  });

  it("still rejects an ambiguous ancestor when creating a leaf", () => {
    mockTree({ "": ["Movies", "movies"] });
    return expect(
      resolveCanonicalSubfolder(target, creds, "media", "movies/new", { mustExist: false }),
    ).rejects.toThrow(NasAmbiguousPathError);
  });

  it("leaves a missing path untouched so the backend reports not-found", () => {
    mockTree({ "": [] });
    return expect(resolveCanonicalSubfolder(target, creds, "media", "ghost/deep")).resolves.toBe("ghost/deep");
  });
});
