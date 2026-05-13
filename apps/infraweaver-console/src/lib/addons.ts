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

interface AddonConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string>;
}

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const ADDON_CONFIGMAP_NAME = "infraweaver-addon-config";
const ENABLED_ADDONS_KEY = "enabledAddons";

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

function parseEnabledAddons(raw?: string) {
  if (!raw) return [...DEFAULT_ENABLED_ADDONS];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // fall back to comma-separated values
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown) {
  return /404|not\s*found/i.test(getErrorMessage(error));
}

async function readAddonConfigMap(): Promise<AddonConfigMap | null> {
  const { makeCoreApi } = await import("@/lib/kube-client");
  const coreApi = makeCoreApi();

  try {
    return await coreApi.readNamespacedConfigMap({
      name: ADDON_CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    }) as AddonConfigMap;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function getEnabledAddons(): Promise<Addon[]> {
  if (typeof window !== "undefined") {
    return withEnabledState(DEFAULT_ENABLED_ADDONS);
  }

  const configMap = await readAddonConfigMap();
  const enabledIds = parseEnabledAddons(
    configMap?.data?.[ENABLED_ADDONS_KEY] ?? configMap?.data?.enabled
  );

  return withEnabledState(enabledIds);
}

export async function isAddonEnabled(id: string) {
  const addons = await getEnabledAddons();
  return addons.some((addon) => addon.id === id && addon.enabled);
}

export async function setAddonEnabled(id: string, enabled: boolean): Promise<Addon[]> {
  if (!ADDONS.some((addon) => addon.id === id)) {
    throw new Error(`Unknown addon: ${id}`);
  }

  const { makeCoreApi } = await import("@/lib/kube-client");
  const coreApi = makeCoreApi();
  const current = await readAddonConfigMap();
  const enabledIds = new Set(
    parseEnabledAddons(current?.data?.[ENABLED_ADDONS_KEY] ?? current?.data?.enabled)
  );

  if (enabled) {
    enabledIds.add(id);
  } else {
    enabledIds.delete(id);
  }

  const nextEnabled = [...enabledIds].sort();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: ADDON_CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      ...(current?.metadata?.resourceVersion ? { resourceVersion: current.metadata.resourceVersion } : {}),
    },
    data: {
      [ENABLED_ADDONS_KEY]: JSON.stringify(nextEnabled),
      updatedAt: new Date().toISOString(),
    },
  };

  if (current) {
    await coreApi.replaceNamespacedConfigMap({
      name: ADDON_CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      body,
    });
  } else {
    await coreApi.createNamespacedConfigMap({
      namespace: CONSOLE_NAMESPACE,
      body,
    });
  }

  return withEnabledState(nextEnabled);
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
