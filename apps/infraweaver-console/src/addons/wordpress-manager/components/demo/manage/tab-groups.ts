/**
 * Presentational clustering for the Manage tab rail. This is purely visual: it
 * decides how the *already-computed* visible panels are grouped and separated in
 * the strip. It never gates a panel and never changes what is available — the
 * source of truth for availability stays in lib/manage/capabilities.ts. Kept as a
 * tiny, pure, dependency-free module so it can be unit-tested in isolation and so
 * capabilities.ts (isomorphic, server + client) is not touched for a client-only
 * concern.
 */
import type { ManagePanelId } from "../../../lib/manage/capabilities";

/** A cluster of related Manage panels. */
export type ManageTabGroupId =
  | "maintain"
  | "content"
  | "protect"
  | "performance"
  | "grow"
  | "people"
  | "diagnose";

export interface ManageTabGroup {
  readonly id: ManageTabGroupId;
  /** Short human name for the cluster (used as the divider's accessible hint). */
  readonly label: string;
}

/** Ordered cluster catalog. Order here is the order clusters render in the rail. */
export const MANAGE_TAB_GROUPS: readonly ManageTabGroup[] = [
  { id: "maintain", label: "Maintain" },
  { id: "content", label: "Content" },
  { id: "protect", label: "Protect" },
  { id: "performance", label: "Performance" },
  { id: "grow", label: "Grow" },
  { id: "people", label: "People" },
  { id: "diagnose", label: "Diagnose" },
];

const GROUP_BY_ID: ReadonlyMap<ManageTabGroupId, ManageTabGroup> = new Map(
  MANAGE_TAB_GROUPS.map((group) => [group.id, group]),
);

/**
 * Which cluster each panel belongs to. Chosen so every cluster is contiguous in
 * the MANAGE_PANELS catalog order; that keeps a filtered (dynamic) tab strip's
 * clusters contiguous too, so the rail draws exactly one divider per boundary.
 */
const PANEL_GROUP: Record<ManagePanelId, ManageTabGroupId> = {
  updates: "maintain",
  inventory: "maintain",
  content: "content",
  media: "content",
  store: "content",
  forms: "content",
  backups: "protect",
  staging: "protect",
  security: "protect",
  audit: "protect",
  performance: "performance",
  resources: "performance",
  uptime: "performance",
  metrics: "performance",
  audience: "grow",
  email: "grow",
  people: "people",
  clients: "people",
  alerts: "diagnose",
  logs: "diagnose",
  data: "diagnose",
  health: "diagnose",
};

/** The cluster a panel belongs to. */
export function panelGroupId(id: ManagePanelId): ManageTabGroupId {
  return PANEL_GROUP[id];
}

/** One contiguous run of visible panels that share a cluster. */
export interface ManageTabSegment<T> {
  readonly group: ManageTabGroup;
  readonly panels: readonly T[];
}

/**
 * Split an ordered list of visible panels into per-cluster segments, preserving
 * the input order and dropping clusters that have no visible panel. A new segment
 * starts whenever the cluster changes while walking the list, so the caller can
 * render a divider between segments. Pure: the input array is never mutated.
 */
export function segmentPanelsByGroup<T extends { readonly id: ManagePanelId }>(
  panels: readonly T[],
): ManageTabSegment<T>[] {
  const segments: { group: ManageTabGroup; panels: T[] }[] = [];
  for (const panel of panels) {
    const groupId = PANEL_GROUP[panel.id];
    const last = segments[segments.length - 1];
    if (last && last.group.id === groupId) {
      last.panels.push(panel);
    } else {
      const group = GROUP_BY_ID.get(groupId);
      if (group) segments.push({ group, panels: [panel] });
    }
  }
  return segments;
}
