// Server-only: uses @kubernetes/client-node via kube-client. Never import from client components.
import { ADDONS, buildAddonList, parseEnabledAddons } from "@/lib/addons";
import type { Addon } from "@/lib/addons";
import { createConfigMapJsonStore, isK8sNotFound } from "@/lib/configmap-store";
import { makeCoreApi } from "@/lib/kube-client";
import { errorMessage } from "@/lib/utils";

interface AddonConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string>;
}

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const ADDON_CONFIGMAP_NAME = "infraweaver-addon-config";
const ENABLED_ADDONS_KEY = "enabledAddons";

const store = createConfigMapJsonStore<{ enabledAddons: string[] }>({
  name: ADDON_CONFIGMAP_NAME,
  namespace: CONSOLE_NAMESPACE,
  keys: [ENABLED_ADDONS_KEY],
});

function isForbiddenError(error: unknown) {
  return /403|forbidden/i.test(errorMessage(error));
}

/**
 * Raw ConfigMap read (not the JSON store): enabled ids may be stored as a
 * comma-separated legacy string, which parseEnabledAddons handles.
 */
async function readAddonConfigMap(): Promise<AddonConfigMap | null> {
  const coreApi = makeCoreApi();
  try {
    return (await coreApi.readNamespacedConfigMap({
      name: ADDON_CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as AddonConfigMap;
  } catch (error) {
    if (isK8sNotFound(error) || isForbiddenError(error)) return null;
    throw error;
  }
}

/** Enabled addon ids from the ConfigMap, honoring the legacy `enabled` data key. */
function readEnabledIds(configMap: AddonConfigMap | null): string[] {
  return parseEnabledAddons(configMap?.data?.[ENABLED_ADDONS_KEY] ?? configMap?.data?.enabled);
}

export async function getEnabledAddons(): Promise<Addon[]> {
  return buildAddonList(readEnabledIds(await readAddonConfigMap()));
}

export async function isAddonEnabled(id: string): Promise<boolean> {
  const addons = await getEnabledAddons();
  return addons.some((addon) => addon.id === id && addon.enabled);
}

export async function setAddonEnabled(id: string, enabled: boolean): Promise<Addon[]> {
  if (!ADDONS.some((addon) => addon.id === id)) {
    throw new Error(`Unknown addon: ${id}`);
  }

  const enabledIds = new Set(readEnabledIds(await readAddonConfigMap()));
  if (enabled) {
    enabledIds.add(id);
  } else {
    enabledIds.delete(id);
  }

  const nextEnabled = [...enabledIds].sort();
  await store.save({ enabledAddons: nextEnabled });
  return buildAddonList(nextEnabled);
}
