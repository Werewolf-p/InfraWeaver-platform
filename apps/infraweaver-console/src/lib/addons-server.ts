// Server-only: uses @kubernetes/client-node via kube-client. Never import from client components.
import { ADDONS, buildAddonList, parseEnabledAddons } from "@/lib/addons";
import type { Addon } from "@/lib/addons";

interface AddonConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string>;
}

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const ADDON_CONFIGMAP_NAME = "infraweaver-addon-config";
const ENABLED_ADDONS_KEY = "enabledAddons";

function isNotFoundError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return /404|not\s*found/i.test(msg);
}

async function readAddonConfigMap(): Promise<AddonConfigMap | null> {
  const { makeCoreApi } = await import("@/lib/kube-client");
  const coreApi = makeCoreApi();
  try {
    return (await coreApi.readNamespacedConfigMap({
      name: ADDON_CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as AddonConfigMap;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function getEnabledAddons(): Promise<Addon[]> {
  const configMap = await readAddonConfigMap();
  const enabledIds = parseEnabledAddons(
    configMap?.data?.[ENABLED_ADDONS_KEY] ?? configMap?.data?.enabled
  );
  return buildAddonList(enabledIds);
}

export async function isAddonEnabled(id: string): Promise<boolean> {
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
      ...(current?.metadata?.resourceVersion
        ? { resourceVersion: current.metadata.resourceVersion }
        : {}),
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
    await coreApi.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }

  return buildAddonList(nextEnabled);
}
