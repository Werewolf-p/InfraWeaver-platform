/**
 * Section model for the Manage console's VERTICAL grouped rail. Purely
 * presentational and dependency-free (no React, no server imports) so it is
 * unit-testable in isolation and safe to import from both the isomorphic
 * capabilities layer and the client rail.
 *
 * It never gates a panel — availability is still owned by
 * lib/manage/capabilities.ts. This module only decides how the *already
 * computed* available panels, plus two always-present synthetic sections
 * (Overview landing + Settings surface), are clustered into labeled groups and
 * ordered in the rail. Replaces the previous horizontal `tab-groups.ts`.
 */
import { getPanelDef, type ManagePanelId } from "../../../lib/manage/capabilities";

/** Sections that are not backed by a `MANAGE_PANELS` entry — always available. */
export type SyntheticSectionId = "overview" | "settings";

/** A rail section: a real gated panel, or a synthetic always-on section. */
export type ManageSectionId = ManagePanelId | SyntheticSectionId;

/** Sentinel id for the trailing "Optional (not installed)" surface — never a real section. */
export const OPTIONAL_SECTION = "__optional__";
export type ManageRailTarget = ManageSectionId | typeof OPTIONAL_SECTION;

interface SyntheticSectionMeta {
  readonly id: SyntheticSectionId;
  readonly label: string;
  /** Icon key resolved to a lucide component client-side (see tab-icons). */
  readonly icon: string;
  readonly summary: string;
}

export const SYNTHETIC_SECTIONS: Readonly<Record<SyntheticSectionId, SyntheticSectionMeta>> = {
  overview: {
    id: "overview",
    label: "Overview",
    icon: "LayoutDashboard",
    summary: "Site status at a glance, with jump-offs into every section.",
  },
  settings: {
    id: "settings",
    label: "Settings",
    icon: "SlidersHorizontal",
    summary: "Site identity, localization, admin email and maintenance mode.",
  },
};

export function isSyntheticSection(id: string): id is SyntheticSectionId {
  return id === "overview" || id === "settings";
}

/**
 * A labeled cluster of related sections in the rail. Grouped by the OWNER'S JOB in
 * plain language ("Keep it safe", "Speed & fixes") rather than by WordPress
 * mechanics ("Operations", "Monitoring") — and the care-plan trio a site owner
 * actually pays for (updates + plugins + backups + security) is co-located at the
 * top instead of scattered across three engineer-named groups.
 */
export type ManageGroupId =
  | "overview"
  | "keep-safe"
  | "content"
  | "people"
  | "speed"
  | "insights"
  | "settings";

export interface ManageGroupDef {
  readonly id: ManageGroupId;
  readonly label: string;
  /** Icon key resolved to a lucide component client-side (see tab-icons). */
  readonly icon: string;
  /** Ordered member section ids (real panels + synthetic sections). */
  readonly sections: readonly ManageSectionId[];
}

/**
 * The rail's group catalog, in render order. Every one of the 22 `MANAGE_PANELS`
 * ids appears in exactly one group; the two synthetic sections anchor their groups
 * (Overview leads "Home", Settings leads "Settings"). Grouped by the owner's job:
 *
 *  - "Keep it safe" co-locates the care-plan trio the owner pays for — updates,
 *    plugins/themes, backups, security — that the old taxonomy scattered across
 *    Extensions / Operations / Security.
 *  - "Speed & fixes" gathers the tune/repair panels; "Insights" everything that
 *    only reports; "Settings" the configuration surfaces.
 *
 * Nothing here gates a panel — availability is owned by capabilities.ts. This is a
 * pure relabel/regroup, so the API and capability model are untouched.
 */
export const MANAGE_GROUPS: readonly ManageGroupDef[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", sections: ["overview"] },
  {
    id: "keep-safe",
    label: "Keep it safe",
    icon: "ShieldCheck",
    sections: ["updates", "inventory", "backups", "security"],
  },
  { id: "content", label: "Content", icon: "FileText", sections: ["content", "media", "store", "forms"] },
  { id: "people", label: "People", icon: "Users", sections: ["people", "clients"] },
  {
    id: "speed",
    label: "Speed & fixes",
    icon: "Gauge",
    sections: ["performance", "data", "resources", "staging"],
  },
  {
    id: "insights",
    label: "Insights",
    icon: "Activity",
    sections: ["health", "uptime", "metrics", "audience", "audit", "alerts", "logs"],
  },
  { id: "settings", label: "Settings", icon: "SlidersHorizontal", sections: ["settings", "email"] },
];

/** One resolved section in the rail — label + icon resolved, availability applied. */
export interface VisibleSection {
  readonly id: ManageSectionId;
  readonly label: string;
  readonly icon: string;
  readonly synthetic: boolean;
}

/** A group with only its currently-available sections (empty groups are dropped). */
export interface VisibleGroup {
  readonly id: ManageGroupId;
  readonly label: string;
  readonly icon: string;
  readonly sections: readonly VisibleSection[];
}

function resolveSection(id: ManageSectionId): VisibleSection | null {
  if (isSyntheticSection(id)) {
    const meta = SYNTHETIC_SECTIONS[id];
    return { id, label: meta.label, icon: meta.icon, synthetic: true };
  }
  const def = getPanelDef(id);
  if (!def) return null;
  return { id, label: def.label, icon: def.icon, synthetic: false };
}

/**
 * Build the visible, grouped rail. Synthetic sections are always present; a real
 * panel is included only when its id is in `availablePanelIds`. Groups left with
 * no visible section are dropped. Pure: inputs are never mutated.
 */
export function buildVisibleGroups(availablePanelIds: ReadonlySet<ManagePanelId>): VisibleGroup[] {
  const groups: VisibleGroup[] = [];
  for (const group of MANAGE_GROUPS) {
    const sections: VisibleSection[] = [];
    for (const sectionId of group.sections) {
      if (!isSyntheticSection(sectionId) && !availablePanelIds.has(sectionId)) continue;
      const resolved = resolveSection(sectionId);
      if (resolved) sections.push(resolved);
    }
    if (sections.length > 0) {
      groups.push({ id: group.id, label: group.label, icon: group.icon, sections });
    }
  }
  return groups;
}

/** Flat, ordered list of every visible section id — powers keyboard nav + clamping. */
export function flattenSections(groups: readonly VisibleGroup[]): ManageSectionId[] {
  return groups.flatMap((group) => group.sections.map((section) => section.id));
}
