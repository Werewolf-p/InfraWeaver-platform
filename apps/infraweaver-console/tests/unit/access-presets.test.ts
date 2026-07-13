jest.mock("server-only", () => ({}), { virtual: true });

import { ACCESS_PRESETS, expandPresetGrants, isAccessPresetId } from "@/lib/users/access-presets";

describe("access-presets", () => {
  it("exposes all / jellyfin / storage presets", () => {
    expect(ACCESS_PRESETS.map((p) => p.id)).toEqual(["all", "jellyfin", "storage"]);
  });

  it("validates preset ids", () => {
    expect(isAccessPresetId("jellyfin")).toBe(true);
    expect(isAccessPresetId("storage")).toBe(true);
    expect(isAccessPresetId("nope")).toBe(false);
  });

  it("expands jellyfin to a single grant", () => {
    expect(expandPresetGrants(["jellyfin"])).toEqual([{ roleId: "jellyfin-user", scope: "/jellyfin" }]);
  });

  it("expands storage to a storage-contributor grant", () => {
    const grants = expandPresetGrants(["storage"]);
    expect(grants).toHaveLength(1);
    expect(grants[0].roleId).toBe("storage-contributor");
    expect(grants[0].scope).toContain("/nas/");
  });

  it("dedupes overlapping presets (all + jellyfin never doubles jellyfin)", () => {
    const grants = expandPresetGrants(["all", "jellyfin"]);
    const jf = grants.filter((g) => g.roleId === "jellyfin-user");
    expect(jf).toHaveLength(1);
    expect(grants.some((g) => g.roleId === "storage-contributor")).toBe(true);
  });

  it("drops unknown ids", () => {
    expect(expandPresetGrants(["bogus"])).toEqual([]);
  });
});
