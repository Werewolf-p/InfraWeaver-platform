import type { Session } from "next-auth";
import { findUserByEmail } from "@/lib/authentik";
import { makeCoreApi } from "@/lib/kube-client";
import {
  DEFAULT_USER_PREFERENCES,
  mergeUserPreferences,
  normalizeUserPreferences,
  type UserPreferencesPayload,
  type UserPreferencesUpdate,
} from "@/lib/user-preferences";

interface PreferencesConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_PREFIX = "infraweaver-user-prefs-";

function isNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not\s*found/i.test(message);
}

function safeParseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function sanitizeUsernameForConfigMap(rawUsername: string): string {
  const sanitized = rawUsername
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const maxUsernameLength = 63 - CONFIGMAP_PREFIX.length;
  const trimmed = sanitized.slice(0, maxUsernameLength).replace(/-+$/g, "");
  return trimmed || "user";
}

function configMapNameForUsername(username: string) {
  return `${CONFIGMAP_PREFIX}${sanitizeUsernameForConfigMap(username)}`;
}

function parseConfigMapPreferences(configMap: PreferencesConfigMap | null): UserPreferencesPayload {
  const payload = safeParseJson<Partial<UserPreferencesPayload>>(configMap?.data?.preferences);
  if (payload) return normalizeUserPreferences(payload);

  return normalizeUserPreferences({
    dashboardLayout: safeParseJson(configMap?.data?.dashboardLayout),
    pinnedApps: safeParseJson(configMap?.data?.pinnedApps),
    theme: configMap?.data?.theme,
    recentlyVisited: safeParseJson(configMap?.data?.recentlyVisited),
    recentSearches: safeParseJson(configMap?.data?.recentSearches),
  });
}

async function readPreferencesConfigMap(name: string): Promise<PreferencesConfigMap | null> {
  const coreApi = makeCoreApi();
  try {
    return (await coreApi.readNamespacedConfigMap({
      name,
      namespace: CONSOLE_NAMESPACE,
    })) as PreferencesConfigMap;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function resolvePreferenceUsername(session: Session): Promise<string> {
  const explicitUsername = (session.user as { username?: string } | undefined)?.username?.trim();
  if (explicitUsername) return explicitUsername;

  const email = (session.user as { email?: string } | undefined)?.email?.trim();
  if (email) {
    try {
      const user = await findUserByEmail(email);
      if (typeof user?.username === "string" && user.username.trim().length > 0) {
        return user.username.trim();
      }
    } catch {
      // Ignore lookup failures and fall back to the email local-part.
    }
    const localPart = email.split("@")[0]?.trim();
    if (localPart) return localPart;
  }

  return session.user?.name?.trim() || "user";
}

export async function getUserPreferences(session: Session) {
  const username = await resolvePreferenceUsername(session);
  const configMapName = configMapNameForUsername(username);
  const configMap = await readPreferencesConfigMap(configMapName);

  return {
    username,
    configMapName,
    preferences: configMap ? parseConfigMapPreferences(configMap) : DEFAULT_USER_PREFERENCES,
    resourceVersion: configMap?.metadata?.resourceVersion,
  };
}

export async function updateUserPreferences(session: Session, update: UserPreferencesUpdate) {
  const current = await getUserPreferences(session);
  const nextPreferences = mergeUserPreferences(current.preferences, update);
  const coreApi = makeCoreApi();
  const updatedAt = new Date().toISOString();

  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: current.configMapName,
      namespace: CONSOLE_NAMESPACE,
      ...(current.resourceVersion ? { resourceVersion: current.resourceVersion } : {}),
    },
    data: {
      dashboardLayout: JSON.stringify(nextPreferences.dashboardLayout),
      pinnedApps: JSON.stringify(nextPreferences.pinnedApps),
      theme: nextPreferences.theme,
      recentlyVisited: JSON.stringify(nextPreferences.recentlyVisited),
      recentSearches: JSON.stringify(nextPreferences.recentSearches),
      preferences: JSON.stringify(nextPreferences),
      updatedAt,
    },
  };

  if (current.resourceVersion) {
    await coreApi.replaceNamespacedConfigMap({
      name: current.configMapName,
      namespace: CONSOLE_NAMESPACE,
      body,
    });
  } else {
    await coreApi.createNamespacedConfigMap({
      namespace: CONSOLE_NAMESPACE,
      body,
    });
  }

  return {
    username: current.username,
    configMapName: current.configMapName,
    preferences: nextPreferences,
  };
}
