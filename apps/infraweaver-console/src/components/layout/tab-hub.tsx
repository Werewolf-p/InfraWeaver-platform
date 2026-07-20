"use client";

import type { ComponentType, ElementType } from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SectionTabs } from "@/components/ui/section-tabs";

export interface HubTab {
  /** URL value, e.g. "drift" → /config?tab=drift. The first tab is the bare base path. */
  value: string;
  label: string;
  icon?: ElementType;
  badge?: string | number;
  Component: ComponentType;
}

interface TabHubProps {
  basePath: string;
  tabs: HubTab[];
}

/** Tab chrome mapped from HubTabs — shared by the live hub and its fallback. */
function toSectionTabs(tabs: HubTab[]) {
  return tabs.map(({ value, label, icon, badge }) => ({ value, label, icon, badge }));
}

/**
 * The live hub: reads `?tab=` to pick the active view and mirrors tab changes
 * back into the query. Because it calls `useSearchParams()`, it MUST render
 * inside a `<Suspense>` boundary (see `TabHub`) — otherwise a statically
 * prerendered hub page hits Next's `missing-suspense-with-csr-bailout` and the
 * route blanks on soft-nav (the /wordpress + /workloads class of bug).
 */
function TabHubInner({ basePath, tabs }: TabHubProps) {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("tab");
  const activeValue = tabs.some((tab) => tab.value === requested) ? (requested as string) : tabs[0].value;
  const active = tabs.find((tab) => tab.value === activeValue) ?? tabs[0];
  const ActiveView = active.Component;

  const onTabChange = (value: string) => {
    const href = value === tabs[0].value ? basePath : `${basePath}?tab=${value}`;
    router.replace(href, { scroll: false });
  };

  return (
    <div className="space-y-4">
      <SectionTabs tabs={toSectionTabs(tabs)} activeTab={activeValue} onTabChange={onTabChange} />
      <ActiveView />
    </div>
  );
}

/**
 * Prerender-safe fallback rendered while the search params resolve: shows the
 * tab chrome and the default (first) tab's view — the no-`?tab=` state — so the
 * hub renders real content at SSR/prerender time instead of a blank. On the
 * client the boundary resolves immediately after hydration and `TabHubInner`
 * takes over, honouring any deep-linked `?tab=`.
 */
function TabHubFallback({ tabs }: { tabs: HubTab[] }) {
  const DefaultView = tabs[0].Component;
  return (
    <div className="space-y-4">
      <SectionTabs tabs={toSectionTabs(tabs)} activeTab={tabs[0].value} onTabChange={() => {}} />
      <DefaultView />
    </div>
  );
}

/**
 * A tabbed hub that consolidates several previously-standalone pages into one
 * destination without changing their components. Each tab renders the original
 * page's extracted view (full functionality intact); the active tab is mirrored
 * into the `?tab=` query so old routes can deep-link in via redirects. Only the
 * active view mounts, so per-tab data fetching stays lazy.
 *
 * The `useSearchParams()` read lives in `TabHubInner`, wrapped here in a
 * `<Suspense>` boundary so every hub page (Workloads, Config, Identity, …) is
 * prerender-safe by construction — no per-page `force-dynamic` needed, and a new
 * hub can't silently reintroduce the CSR-bailout blank-nav bug.
 */
export function TabHub(props: TabHubProps) {
  return (
    <Suspense fallback={<TabHubFallback tabs={props.tabs} />}>
      <TabHubInner {...props} />
    </Suspense>
  );
}
