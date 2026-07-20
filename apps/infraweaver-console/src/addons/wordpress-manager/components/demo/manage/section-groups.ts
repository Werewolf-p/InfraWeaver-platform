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

/** A labeled cluster of related sections in the rail. */
export type ManageGroupId =
  | "overview"
  | "content"
  | "people"
  | "extensions"
  | "configuration"
  | "operations"
  | "monitoring"
  | "security";

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
 * ids appears in exactly one group; the two synthetic sections anchor their
 * groups (Overview leads, Settings sits in Configuration). Adjusted from the
 * convergent WP-manager taxonomy to the console's real panel set.
 */
export const MANAGE_GROUPS: readonly ManageGroupDef[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", sections: ["overview"] },
  { id: "content", label: "Content", icon: "FileText", sections: ["content", "media", "store", "forms"] },
  { id: "people", label: "People", icon: "Users", sections: ["people", "clients"] },
  { id: "extensions", label: "Extensions", icon: "Puzzle", sections: ["updates", "inventory"] },
  {
    id: "configuration",
    label: "Configuration",
    icon: "SlidersHorizontal",
    sections: ["settings", "email", "audience", "audit"],
  },
  {
    id: "operations",
    label: "Operations",
    icon: "Wrench",
    sections: ["data", "performance", "resources", "backups", "staging"],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: "Activity",
    sections: ["health", "uptime", "metrics", "alerts", "logs"],
  },
  { id: "security", label: "Security", icon: "ShieldCheck", sections: ["security"] },
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
