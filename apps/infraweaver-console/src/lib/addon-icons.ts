import type { ComponentType } from "react";
import {
  Gamepad2,
  Globe,
  Network,
  Puzzle,
  Server,
  ShieldCheck,
} from "lucide-react";

/** Icon component shape shared by nav items (matches PageIcon in page-registry). */
export type AddonIcon = ComponentType<{ className?: string }>;

/**
 * Resolve an addon manifest icon name (a string, since manifests are plain data)
 * to a Lucide component. Shared by the sidebar's manifest-driven Addons group and
 * the addon settings UI so both stay in sync. Unknown names fall back to Puzzle.
 */
const ADDON_ICONS: Record<string, AddonIcon> = {
  Gamepad2,
  Globe,
  Network,
  Puzzle,
  Server,
  ShieldCheck,
};

export function resolveAddonIcon(name: string | undefined): AddonIcon {
  return (name && ADDON_ICONS[name]) || Puzzle;
}
