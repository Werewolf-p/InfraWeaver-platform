// Traversal-guard tests for the NAS subfolder path model.
//
// Every NAS write path (mkdir, ACL grant) and every generated mount ultimately
// resolves an operator-supplied subfolder against a share's absolute path on
// the appliance. If `normalizeSubfolder` can be talked into emitting `..`, an
// absolute path, or a NUL byte, the console can be made to create folders — and
// grant its service accounts ACLs — anywhere on the NAS filesystem.
//
// These assertions are the security boundary. Do not relax them.

import { joinNasPath, normalizeSubfolder, slugifyPathSegment } from "@/lib/nas/paths";

describe("normalizeSubfolder", () => {
  it("accepts a simple folder name", () => {
    expect(normalizeSubfolder("media")).toBe("media");
  });

  it("accepts nested folders and collapses redundant separators", () => {
    expect(normalizeSubfolder("media//movies/")).toBe("media/movies");
    expect(normalizeSubfolder("/media/movies")).toBe("media/movies");
  });

  it("treats empty, whitespace and '/' as the share root", () => {
    expect(normalizeSubfolder("")).toBe("");
    expect(normalizeSubfolder("   ")).toBe("");
    expect(normalizeSubfolder("/")).toBe("");
    expect(normalizeSubfolder(undefined)).toBe("");
  });

  it("rejects parent-directory traversal in every position", () => {
    expect(() => normalizeSubfolder("..")).toThrow(/traversal/i);
    expect(() => normalizeSubfolder("../etc")).toThrow(/traversal/i);
    expect(() => normalizeSubfolder("media/../../etc")).toThrow(/traversal/i);
    expect(() => normalizeSubfolder("media/..")).toThrow(/traversal/i);
  });

  it("rejects a bare '.' segment", () => {
    expect(() => normalizeSubfolder("./media")).toThrow(/segment/i);
    expect(() => normalizeSubfolder("media/./movies")).toThrow(/segment/i);
  });

  it("rejects NUL bytes, newlines and control characters", () => {
    expect(() => normalizeSubfolder("media\0/etc")).toThrow(/character/i);
    expect(() => normalizeSubfolder("media\nmovies")).toThrow(/character/i);
    expect(() => normalizeSubfolder("media\tmovies")).toThrow(/character/i);
  });

  it("rejects backslashes so a Windows/SMB path cannot smuggle a separator", () => {
    expect(() => normalizeSubfolder("media\\..\\etc")).toThrow(/character/i);
  });

  it("rejects characters outside the safe segment charset", () => {
    expect(() => normalizeSubfolder("media;rm -rf")).toThrow(/character/i);
    expect(() => normalizeSubfolder("media$(id)")).toThrow(/character/i);
    expect(() => normalizeSubfolder("média")).toThrow(/character/i);
  });

  it("rejects a segment that is only dots", () => {
    expect(() => normalizeSubfolder("...")).toThrow(/segment/i);
  });

  it("enforces depth and length caps", () => {
    expect(() => normalizeSubfolder("a/b/c/d/e/f/g/h/i")).toThrow(/deep/i);
    expect(() => normalizeSubfolder("a".repeat(256))).toThrow(/long/i);
    expect(() => normalizeSubfolder(`${"a".repeat(120)}/${"b".repeat(120)}/${"c".repeat(120)}`)).toThrow(/long/i);
  });

  it("allows dots, dashes and underscores inside a segment", () => {
    expect(normalizeSubfolder("tv_shows/season-1/ep.01")).toBe("tv_shows/season-1/ep.01");
  });
});

describe("joinNasPath", () => {
  it("returns the share path unchanged for the share root", () => {
    expect(joinNasPath("/mnt/Main/infraweaver", "")).toBe("/mnt/Main/infraweaver");
  });

  it("joins a normalized subfolder onto the share path", () => {
    expect(joinNasPath("/mnt/Main/infraweaver", "media")).toBe("/mnt/Main/infraweaver/media");
    expect(joinNasPath("/mnt/Main/infraweaver/", "media/movies")).toBe("/mnt/Main/infraweaver/media/movies");
  });

  it("refuses a share path that is not absolute", () => {
    expect(() => joinNasPath("mnt/Main", "media")).toThrow(/absolute/i);
  });

  it("re-validates the subfolder, so a raw value can never bypass the guard", () => {
    expect(() => joinNasPath("/mnt/Main/infraweaver", "../../etc")).toThrow(/traversal/i);
  });

  it("never escapes the share path", () => {
    for (const attempt of ["media/../..", "..", "a/../../b"]) {
      expect(() => joinNasPath("/mnt/Main/infraweaver", attempt)).toThrow();
    }
  });
});

describe("slugifyPathSegment", () => {
  it("produces a DNS-1123 safe label for k8s object names", () => {
    expect(slugifyPathSegment("media/movies")).toBe("media-movies");
    expect(slugifyPathSegment("TV_Shows")).toBe("tv-shows");
    expect(slugifyPathSegment("ep.01")).toBe("ep-01");
  });

  it("collapses runs and trims leading/trailing separators", () => {
    expect(slugifyPathSegment("__a//b__")).toBe("a-b");
  });

  it("falls back to 'root' for the share root", () => {
    expect(slugifyPathSegment("")).toBe("root");
  });

  it("stays within the k8s label budget", () => {
    expect(slugifyPathSegment("a".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});
