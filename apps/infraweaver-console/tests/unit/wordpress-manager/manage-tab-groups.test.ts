import { MANAGE_PANELS, type ManagePanelDef, type ManagePanelId } from "@/addons/wordpress-manager/lib/manage/capabilities";
import {
  MANAGE_TAB_GROUPS,
  panelGroupId,
  segmentPanelsByGroup,
} from "@/addons/wordpress-manager/components/demo/manage/tab-groups";

const byId = (id: ManagePanelId): ManagePanelDef => {
  const panel = MANAGE_PANELS.find((p) => p.id === id);
  if (!panel) throw new Error(`unknown panel ${id}`);
  return panel;
};

describe("panelGroupId", () => {
  test("assigns every catalog panel to a known cluster", () => {
    const knownGroups = new Set(MANAGE_TAB_GROUPS.map((g) => g.id));
    for (const panel of MANAGE_PANELS) {
      expect(knownGroups.has(panelGroupId(panel.id))).toBe(true);
    }
  });
});

describe("segmentPanelsByGroup", () => {
  test("segments the full catalog into contiguous clusters in group order", () => {
    const segments = segmentPanelsByGroup(MANAGE_PANELS);

    // Every cluster is contiguous in catalog order, so the whole catalog yields
    // exactly one segment per group, in the declared group order.
    expect(segments.map((s) => s.group.id)).toEqual(MANAGE_TAB_GROUPS.map((g) => g.id));

    // No panel is dropped or reordered.
    expect(segments.flatMap((s) => s.panels.map((p) => p.id))).toEqual(MANAGE_PANELS.map((p) => p.id));

    // Each segment holds only panels of its own cluster.
    for (const segment of segments) {
      for (const panel of segment.panels) {
        expect(panelGroupId(panel.id)).toBe(segment.group.id);
      }
    }
  });

  test("drops clusters that have no visible panel and keeps input order", () => {
    // A bare site: only the always-available (null-requirement) panels remain.
    const visible = MANAGE_PANELS.filter((p) => p.requires === null);
    const segments = segmentPanelsByGroup(visible);

    expect(segments.flatMap((s) => s.panels.map((p) => p.id))).toEqual(visible.map((p) => p.id));
    // "grow" (audience/email) and "people" (clients side) become empty here — no
    // empty segment should appear.
    for (const segment of segments) {
      expect(segment.panels.length).toBeGreaterThan(0);
    }
    // The visible clusters are a subset of the catalog order, still ascending.
    const catalogOrder = MANAGE_TAB_GROUPS.map((g) => g.id);
    const seenIndexes = segments.map((s) => catalogOrder.indexOf(s.group.id));
    expect(seenIndexes).toEqual([...seenIndexes].sort((a, b) => a - b));
  });

  test("returns a single segment for one panel", () => {
    const segments = segmentPanelsByGroup([byId("updates")]);
    expect(segments).toHaveLength(1);
    expect(segments[0].group.id).toBe("maintain");
    expect(segments[0].panels.map((p) => p.id)).toEqual(["updates"]);
  });

  test("returns no segments for an empty list", () => {
    expect(segmentPanelsByGroup([])).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const input = [byId("updates"), byId("content")];
    const snapshot = [...input];
    segmentPanelsByGroup(input);
    expect(input).toEqual(snapshot);
  });
});
