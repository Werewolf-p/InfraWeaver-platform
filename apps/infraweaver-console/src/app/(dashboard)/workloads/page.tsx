"use client";

import { Gamepad2, Globe, LayoutGrid, Network, Newspaper } from "lucide-react";
import { TabHub, type HubTab } from "@/components/layout/tab-hub";
import { useAddons } from "@/hooks/use-addons";
import { AppsView } from "../apps/view";
import { AppGraphView } from "../app-graph/view";
import { GameHubView } from "../game-hub/view";
import { RoutesView } from "../routes/view";
import { WordpressView } from "../wordpress/view";

/**
 * Workloads hub — one landing for everything you run: Apps, the dependency Graph,
 * Game Servers, WordPress, and Routing & DNS (incl. port routing). Game Servers
 * and WordPress tabs are addon-gated: they self-hide when their addon is disabled,
 * mirroring the sidebar's filterNavGroupsByAddons rule. Each tab lazy-mounts
 * (TabHub) so per-tab data fetching stays lazy.
 */
export default function WorkloadsPage() {
  const { isEnabled } = useAddons();

  const tabs: HubTab[] = [
    { value: "apps", label: "Apps", icon: LayoutGrid, Component: AppsView },
    { value: "graph", label: "Graph", icon: Network, Component: AppGraphView },
    ...(isEnabled("game-hub")
      ? [{ value: "game", label: "Game Servers", icon: Gamepad2, Component: GameHubView }]
      : []),
    ...(isEnabled("wordpress-manager")
      ? [{ value: "wordpress", label: "WordPress", icon: Newspaper, Component: WordpressView }]
      : []),
    { value: "routing", label: "Routing", icon: Globe, Component: RoutesView },
  ];

  return <TabHub basePath="/workloads" tabs={tabs} />;
}
