/** @jest-environment node */
// Section-rail grouping for the Manage console's vertical nav: every panel belongs
// to exactly one group, synthetic Overview + Settings are always present, and empty
// groups are dropped as capabilities resolve. Pure/presentational — never gates.
import { MANAGE_PANELS, type ManagePanelId } from "@/addons/wordpress-manager/lib/manage/capabilities";
import {
  MANAGE_GROUPS,
  buildVisibleGroups,
  flattenSections,
  isSyntheticSection,
  type ManageSectionId,
} from "@/addons/wordpress-manager/components/demo/manage/section-groups";

const ALL_PANEL_IDS = new Set<ManagePanelId>(MANAGE_PANELS.map((p) => p.id));

describe("section-groups membership", () => {
  test("every MANAGE_PANELS id belongs to exactly one group", () => {
    const seen = new Map<ManageSectionId, number>();
    for (const group of MANAGE_GROUPS) {
      for (const id of group.sections) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const panel of MANAGE_PANELS) {
      expect(seen.get(panel.id)).toBe(1);
    }
  });

  test("groups reference no unknown panel ids", () => {
    for (const group of MANAGE_GROUPS) {
      for (const id of group.sections) {
        if (isSyntheticSection(id)) continue;
        expect(ALL_PANEL_IDS.has(id)).toBe(true);
      }
    }
  });
});

describe("buildVisibleGroups", () => {
  test("includes synthetic Overview + Settings even with no panels available", () => {
    const groups = buildVisibleGroups(new Set());
    const flat = flattenSections(groups);
    expect(flat).toContain("overview");
    expect(flat).toContain("settings");
    expect(groups.map((g) => g.id)).toEqual(["overview", "configuration"]);
  });

  test("drops groups with no available panel and no synthetic member", () => {
    const groups = buildVisibleGroups(new Set());
    expect(groups.find((g) => g.id === "security")).toBeUndefined();
    expect(groups.find((g) => g.id === "monitoring")).toBeUndefined();
  });

  test("includes available panels and preserves catalog order within a group", () => {
    const groups = buildVisibleGroups(new Set<ManagePanelId>(["content", "media", "people"]));
    expect(groups.find((g) => g.id === "content")?.sections.map((s) => s.id)).toEqual(["content", "media"]);
    expect(groups.find((g) => g.id === "people")?.sections.map((s) => s.id)).toEqual(["people"]);
  });

  test("resolves panel labels from the capability registry", () => {
    const groups = buildVisibleGroups(new Set<ManagePanelId>(["people"]));
    const section = groups.find((g) => g.id === "people")?.sections[0];
    expect(section?.label).toBe("Users");
    expect(section?.synthetic).toBe(false);
  });

  test("all panels available ⇒ every group present, 24 total sections", () => {
    const groups = buildVisibleGroups(ALL_PANEL_IDS);
    expect(groups).toHaveLength(MANAGE_GROUPS.length);
    expect(flattenSections(groups)).toHaveLength(24); // 22 panels + 2 synthetic
  });
});
