/**
 * @/lib/addon-sdk — Host SDK surface addons may import.
 * Addons MUST only import from this barrel.
 */

// ── Types / schema ────────────────────────────────────────────────────────────
export type {
  Addon,
  AddonNavItem,
  AddonManifest,
  AddonPage,
  AddonNavItemManifest,
  AddonApi,
  AddonPermission,
  AddonK8s,
  AddonDependency,
} from "./types";
export { addonManifestSchema, manifestToAddon } from "./types";

// ── Addon state ───────────────────────────────────────────────────────────────
export {
  ADDONS,
  DEFAULT_ENABLED_ADDONS,
  filterNavGroupsByAddons,
  buildAddonList,
  parseEnabledAddons,
} from "@/lib/addons";

// ── Client hook ───────────────────────────────────────────────────────────────
export { useAddons } from "@/hooks/use-addons";

// ── Auth / RBAC ───────────────────────────────────────────────────────────────
export { withRoute } from "@/lib/route-utils";

// ── Utilities ────────────────────────────────────────────────────────────────
export { safeError } from "@/lib/utils";
