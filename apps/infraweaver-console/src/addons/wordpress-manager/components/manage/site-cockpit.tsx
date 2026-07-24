"use client";

/**
 * `SiteCockpit` — the additive scaffold for the unified per-site surface. It
 * promotes the existing Manage vertical rail (`SectionNav`) from "Manage's nav" to
 * "the site's nav" and syncs the active section to `?section=<id>` in the URL,
 * using the Suspense-safe `tab-hub` pattern (a `useSearchParams` read wrapped in a
 * `<Suspense>` boundary) so deep links like `?section=media` work cold and the
 * historical blank-nav CSR-bailout bug can't return.
 *
 * ADDITIVE: this does not delete or redirect the existing manage/connector routes.
 * Domain steps supply real section bodies via `renderSection`; until then each
 * section shows a placeholder. Availability + grouping stay owned by
 * `capabilities.ts` / `section-groups.ts` — this only renders them.
 */

import { Suspense, useCallback, useMemo, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "../demo/manage/kit/empty-state";
import { SectionNav, SectionNavSkeleton } from "../demo/manage/section-nav";
import {
  MANAGE_GROUPS,
  OPTIONAL_SECTION,
  buildVisibleGroups,
  flattenSections,
  isSyntheticSection,
  type ManageRailTarget,
  type ManageSectionId,
} from "../demo/manage/section-groups";
import type { ManagePanelId } from "../../lib/manage/capabilities";

/** Every real panel id the rail knows about — the default availability set. */
const ALL_PANEL_IDS: ReadonlySet<ManagePanelId> = (() => {
  const ids = new Set<ManagePanelId>();
  for (const group of MANAGE_GROUPS) {
    for (const section of group.sections) {
      if (!isSyntheticSection(section)) ids.add(section as ManagePanelId);
    }
  }
  return ids;
})();

export interface SiteCockpitProps {
  readonly site: string;
  /** Panels available for this site (from capabilities). Defaults to all known panels. */
  readonly availablePanelIds?: ReadonlySet<ManagePanelId>;
  /** Per-section attention badges (e.g. pending updates). */
  readonly badges?: Readonly<Partial<Record<ManageSectionId, number>>>;
  /** How many panels are gated off — drives the trailing "Optional" rail entry. */
  readonly optionalCount?: number;
  /** Render the body for the active section. Domain steps supply real panels here. */
  readonly renderSection?: (section: ManageRailTarget) => ReactNode;
  /** Header actions (freshness / Force renew) rendered top-right. */
  readonly headerRight?: ReactNode;
}

const CONTENT_PANEL_ID = "site-cockpit-panel";

function defaultSectionBody(section: ManageRailTarget): ReactNode {
  return (
    <EmptyState
      title="This section moves here"
      body={`The "${section}" surface lands in the site cockpit as its domain ships. Existing routes still work in the meantime.`}
    />
  );
}

/** The live shell — reads `?section=` (hence must sit inside a Suspense boundary). */
function SiteCockpitInner({
  site,
  availablePanelIds = ALL_PANEL_IDS,
  badges,
  optionalCount = 0,
  renderSection,
  headerRight,
}: SiteCockpitProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const groups = useMemo(() => buildVisibleGroups(availablePanelIds), [availablePanelIds]);
  const sectionOrder = useMemo<ManageRailTarget[]>(() => {
    const ids: ManageRailTarget[] = flattenSections(groups);
    if (optionalCount > 0) ids.push(OPTIONAL_SECTION);
    return ids;
  }, [groups, optionalCount]);

  const requested = searchParams.get("section");
  const active: ManageRailTarget =
    requested && sectionOrder.includes(requested as ManageRailTarget)
      ? (requested as ManageRailTarget)
      : (sectionOrder[0] ?? "overview");

  const onSelect = useCallback(
    (target: ManageRailTarget) => {
      const base = pathname ?? `/wordpress/${encodeURIComponent(site)}`;
      const href = target === sectionOrder[0] ? base : `${base}?section=${target}`;
      router.replace(href, { scroll: false });
    },
    [pathname, router, site, sectionOrder],
  );

  const body = (renderSection ?? defaultSectionBody)(active);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* Sticky vertical rail — promoted to the site's primary nav. */}
      <aside className="lg:sticky lg:top-4 lg:w-60 lg:shrink-0">
        <SectionNav
          groups={groups}
          active={active}
          onSelect={onSelect}
          badges={badges}
          optionalCount={optionalCount}
          idPrefix="cockpit"
          panelId={CONTENT_PANEL_ID}
        />
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        {headerRight ? <div className="flex items-center justify-end gap-2">{headerRight}</div> : null}
        <section
          id={CONTENT_PANEL_ID}
          role="region"
          aria-label="Site section"
          tabIndex={-1}
          className="min-w-0 focus-visible:outline-none"
        >
          {body}
        </section>
      </div>
    </div>
  );
}

/** Suspense-wrapped cockpit — prerender-safe by construction (tab-hub pattern). */
export function SiteCockpit(props: SiteCockpitProps) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-6 lg:flex-row">
          <aside className="lg:w-60 lg:shrink-0">
            <SectionNavSkeleton />
          </aside>
          <div className="min-w-0 flex-1" />
        </div>
      }
    >
      <SiteCockpitInner {...props} />
    </Suspense>
  );
}
