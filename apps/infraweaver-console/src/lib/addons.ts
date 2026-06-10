import { ADDON_MANIFESTS } from "@/generated/addon-registry";
import { manifestToAddon } from "@/lib/addon-sdk/types";

// Re-export legacy shapes from addon-sdk/types so all existing imports keep working.
export type { Addon, AddonNavItem } from "@/lib/addon-sdk/types";
import type { Addon } from "@/lib/addon-sdk/types";

export const DEFAULT_ENABLED_ADDONS: string[] = ADDON_MANIFESTS
  .filter((m) => m.defaultEnabled !== false)
  .map((m) => m.id);

/**
 * ADDONS — derived from the generated ADDON_MANIFESTS registry.
 * Starts with enabled=false; buildAddonList sets live state from ConfigMap.
 */
export const ADDONS: Addon[] = ADDON_MANIFESTS.map((m) => manifestToAddon(m, false));

function withEnabledState(enabledIds: readonly string[]): Addon[] {
  const enabledSet = new Set(enabledIds);
  return ADDONS.map((addon) => ({ ...addon, enabled: enabledSet.has(addon.id) }));
}

export function parseEnabledAddons(raw?: string): string[] {
  if (!raw) return [...DEFAULT_ENABLED_ADDONS];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // fall back to comma-separated
  }
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

export function buildAddonList(enabledIds: readonly string[]): Addon[] {
  return withEnabledState(enabledIds);
}

export function filterNavGroupsByAddons<T extends { items: Array<{ href: string }> }>(
  navGroups: T[],
  addons: Addon[],
) {
  const navVisibility = new Map<string, boolean>();
  for (const addon of addons) {
    for (const navItem of addon.navItems ?? []) {
      navVisibility.set(navItem.href, addon.enabled);
    }
  }
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => navVisibility.get(item.href) ?? true),
    }))
    .filter((group) => group.items.length > 0) as T[];
}
