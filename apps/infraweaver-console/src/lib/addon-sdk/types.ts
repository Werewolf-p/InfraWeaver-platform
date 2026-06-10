import { z } from "zod";

// ── Legacy Addon shape (kept here to avoid circular deps) ────────────────────
// addons.ts re-exports these so all existing imports keep working.
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

// ── Zod schema ────────────────────────────────────────────────────────────────

export const addonPageSchema = z.object({
  /** URL path relative to app root, e.g. "/game-hub" */
  path: z.string(),
  /** Relative path from addon root to the page component, e.g. "pages/index" */
  component: z.string(),
  title: z.string(),
  group: z.string(),
  requiredPermissions: z.array(z.string()).optional(),
});

export const addonNavItemSchema = z.object({
  href: z.string(),
  label: z.string(),
  icon: z.string(),
  group: z.string(),
});

export const addonApiSchema = z.object({
  /** Path relative to /api/game-hub (or whatever prefix), e.g. "servers" */
  path: z.string(),
  /** Relative path from addon root to the handler module, e.g. "api/servers" */
  handler: z.string(),
  methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])),
  permission: z.string().optional(),
});

export const addonPermissionSchema = z.object({
  id: z.string(),
  description: z.string(),
});

export const addonK8sSchema = z.object({
  namespace: z.string(),
  kustomizePath: z.string().optional(),
  ownsLabels: z.record(z.string(), z.string()).optional(),
  requiredClusterPermissions: z.array(z.string()).optional(),
});

export const addonHooksSchema = z.record(z.string(), z.string());

export const addonDependencySchema = z.object({
  id: z.string(),
  optional: z.boolean().optional(),
  reason: z.string().optional(),
});

export const addonManifestSchema = z.object({
  /** Stable identifier, kebab-case, matches existing Addon.id */
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  name: z.string(),
  version: z.string().optional(),
  description: z.string(),
  /** Lucide icon name from allow-list */
  icon: z.string(),
  category: z.enum(["infrastructure", "gaming", "networking", "monitoring"]),
  author: z.string().optional(),
  apiVersion: z.string().optional(),
  defaultEnabled: z.boolean().optional(),
  requiresSetup: z.boolean().optional(),
  setupPath: z.string().optional(),
  pages: z.array(addonPageSchema).optional(),
  navItems: z.array(addonNavItemSchema).optional(),
  api: z.array(addonApiSchema).optional(),
  permissions: z.array(addonPermissionSchema).optional(),
  /** Scope prefix used by navigation-rbac for per-scope permission checks */
  scopePrefix: z.string().optional(),
  k8s: addonK8sSchema.optional(),
  hooks: addonHooksSchema.optional(),
  dependencies: z.array(addonDependencySchema).optional(),
});

// ── TypeScript types ──────────────────────────────────────────────────────────

export type AddonPage = z.infer<typeof addonPageSchema>;
export type AddonNavItemManifest = z.infer<typeof addonNavItemSchema>;
export type AddonApi = z.infer<typeof addonApiSchema>;
export type AddonPermission = z.infer<typeof addonPermissionSchema>;
export type AddonK8s = z.infer<typeof addonK8sSchema>;
export type AddonDependency = z.infer<typeof addonDependencySchema>;

/**
 * Full typed manifest for a self-contained addon.
 * Backward-compatible superset of the existing `Addon` interface.
 */
export type AddonManifest = z.infer<typeof addonManifestSchema>;

/**
 * Convert an AddonManifest to the legacy Addon shape so existing
 * useAddons / filterNavGroupsByAddons / settings UI keep working unchanged.
 */
export function manifestToAddon(manifest: AddonManifest, enabled = false): Addon {
  const navItems: AddonNavItem[] | undefined = manifest.navItems?.map((n) => ({
    href: n.href,
    label: n.label,
    icon: n.icon,
    group: n.group,
  }));

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    enabled,
    navItems,
    requiresSetup: manifest.requiresSetup,
    setupPath: manifest.setupPath,
  };
}
