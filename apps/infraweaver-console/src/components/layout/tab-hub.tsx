"use client";

import type { ComponentType, ElementType } from "react";
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

/**
 * A tabbed hub that consolidates several previously-standalone pages into one
 * destination without changing their components. Each tab renders the original
 * page's extracted view (full functionality intact); the active tab is mirrored
 * into the `?tab=` query so old routes can deep-link in via redirects. Only the
 * active view mounts, so per-tab data fetching stays lazy.
 */
export function TabHub({ basePath, tabs }: TabHubProps) {
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
      <SectionTabs
        tabs={tabs.map(({ value, label, icon, badge }) => ({ value, label, icon, badge }))}
        activeTab={activeValue}
        onTabChange={onTabChange}
      />
      <ActiveView />
    </div>
  );
}
