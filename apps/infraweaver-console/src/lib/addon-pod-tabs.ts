import { ADDON_MANIFESTS, ADDON_POD_TAB_LOADERS } from "@/generated/addon-registry";
import { resolveAddonIcon, type AddonIcon } from "@/lib/addon-icons";

export interface ResolvedPodTab {
  addonId: string;
  /** Unique tab id used for SectionTabs + the ?tab= query, e.g. "addon:wordpress-manager:wordpress". */
  tabId: string;
  label: string;
  icon: AddonIcon;
  /** Permission required to view the tab (undefined = no gate). */
  permission?: string;
  /** Lazy import of the tab component (default export takes { namespace, name, labels }). */
  load: () => Promise<unknown>;
}

/** Build the stable tab id for an addon-contributed pod tab. */
export function addonPodTabId(addonId: string, value: string): string {
  return `addon:${addonId}:${value}`;
}

function labelsMatch(matchLabels: Record<string, string>, podLabels: Record<string, string>): boolean {
  return Object.entries(matchLabels).every(([key, want]) => {
    const actual = podLabels[key];
    if (actual === undefined) return false;
    return want === "*" || actual === want;
  });
}

/**
 * Tabs that enabled addons contribute to a pod's detail page. A tab is included
 * only when its addon is enabled and the pod's labels satisfy the tab's
 * matchLabels — so e.g. the WordPress tab appears only on WordPress pods, never
 * on others. RBAC (per-tab `permission`) is enforced by the caller, which has
 * the session's permissions.
 */
export function resolvePodTabs(
  podLabels: Record<string, string>,
  enabledAddonIds: ReadonlySet<string>,
): ResolvedPodTab[] {
  const tabs: ResolvedPodTab[] = [];
  for (const manifest of ADDON_MANIFESTS) {
    if (!enabledAddonIds.has(manifest.id)) continue;
    for (const tab of manifest.podTabs ?? []) {
      if (!labelsMatch(tab.matchLabels, podLabels)) continue;
      const load = ADDON_POD_TAB_LOADERS[`${manifest.id}::${tab.value}`];
      if (!load) continue;
      tabs.push({
        addonId: manifest.id,
        tabId: addonPodTabId(manifest.id, tab.value),
        label: tab.label,
        icon: resolveAddonIcon(tab.icon),
        permission: tab.permission,
        load,
      });
    }
  }
  return tabs;
}
