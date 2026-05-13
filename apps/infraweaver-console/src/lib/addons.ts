export interface AddonNavItem {
  href: string;
  label: string;
  icon: string;
  group: string;
}

export interface Addon {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "infrastructure" | "gaming" | "networking" | "monitoring";
  enabled: boolean;
  navItems?: AddonNavItem[];
  requiresSetup?: boolean;
  setupPath?: string;
}

export const DEFAULT_ENABLED_ADDONS = ["game-hub", "port-routing"] as const;

export const ADDONS: Addon[] = [
  {
    id: "game-hub",
    name: "Game Hub",
    description: "Deploy and manage game servers (Minecraft, Terraria, Valheim, etc.) directly on Kubernetes",
    icon: "Gamepad2",
    category: "gaming",
    enabled: true,
    requiresSetup: true,
    setupPath: "/game-hub/setup",
    navItems: [{ href: "/game-hub", label: "Game Hub", icon: "Gamepad2", group: "gaming" }],
  },
  {
    id: "port-routing",
    name: "Port Routing",
    description: "TCP/UDP port routing for dedicated VMs and game servers via DNS routing",
    icon: "Network",
    category: "networking",
    enabled: true,
    navItems: [{ href: "/gameservers", label: "Port Routing", icon: "Network", group: "services" }],
  },
];

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

export function filterNavGroupsByAddons<T extends { items: Array<{ href: string }> }>(navGroups: T[], addons: Addon[]) {
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
