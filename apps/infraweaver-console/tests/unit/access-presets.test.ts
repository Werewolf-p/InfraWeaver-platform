jest.mock("server-only", () => ({}), { virtual: true });

import {
  ACCESS_PRESETS,
  expandPresetGrants,
  isAccessPresetId,
  isPrivilegedPresetId,
} from "@/lib/users/access-presets";

describe("access-presets", () => {
  it("exposes per-app/per-role presets plus the legacy union ids", () => {
    expect(ACCESS_PRESETS.map((p) => p.id)).toEqual([
      "jellyfin-user",
      "jellyfin-admin",
      "storage-viewer",
      "storage-contributor",
      "all",
      "jellyfin",
      "storage",
    ]);
  });

  it("validates preset ids", () => {
    expect(isAccessPresetId("jellyfin-user")).toBe(true);
    expect(isAccessPresetId("jellyfin-admin")).toBe(true);
    expect(isAccessPresetId("storage-viewer")).toBe(true);
    expect(isAccessPresetId("jellyfin")).toBe(true);
    expect(isAccessPresetId("storage")).toBe(true);
    expect(isAccessPresetId("nope")).toBe(false);
  });

  it("marks only admin-tier presets as privileged", () => {
    expect(isPrivilegedPresetId("jellyfin-admin")).toBe(true);
    expect(isPrivilegedPresetId("jellyfin-user")).toBe(false);
    expect(isPrivilegedPresetId("storage-contributor")).toBe(false);
    expect(isPrivilegedPresetId("storage-viewer")).toBe(false);
    expect(isPrivilegedPresetId("nope")).toBe(false);
  });

  it("expands jellyfin-user and jellyfin-admin to the right role", () => {
    expect(expandPresetGrants(["jellyfin-user"])).toEqual([{ roleId: "jellyfin-user", scope: "/jellyfin" }]);
    expect(expandPresetGrants(["jellyfin-admin"])).toEqual([{ roleId: "jellyfin-admin", scope: "/jellyfin" }]);
  });

  it("expands storage-viewer (read-only) vs storage-contributor (read-write)", () => {
    expect(expandPresetGrants(["storage-viewer"])[0].roleId).toBe("storage-viewer");
    expect(expandPresetGrants(["storage-contributor"])[0].roleId).toBe("storage-contributor");
    expect(expandPresetGrants(["storage-viewer"])[0].scope).toContain("/nas/");
  });

  it("expands legacy jellyfin to a single grant", () => {
    expect(expandPresetGrants(["jellyfin"])).toEqual([{ roleId: "jellyfin-user", scope: "/jellyfin" }]);
  });

  it("expands legacy storage to a storage-contributor grant", () => {
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
