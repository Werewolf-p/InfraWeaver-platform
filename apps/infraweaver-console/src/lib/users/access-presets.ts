/**
 * Access presets — the human-facing "what should this person be able to use"
 * choices offered on an invite, mapped to the concrete RBAC role + scope grants
 * that drive auto-provisioning. SERVER ONLY.
 *
 * Why presets rather than raw groups/roles: an operator inviting a friend thinks
 * in apps ("give them Jellyfin and the media drive"), not in Authentik group
 * names or scope strings. Each preset expands to the same `role_assignments` the
 * reconcile loop already converges (Jellyfin account, Nextcloud `/Media`), so a
 * preset chosen on an invite ends up fully provisioned with zero further steps.
 *
 * The storage scope is env-overridable (`NEXTCLOUD_MEDIA_STORAGE_SCOPE`) but
 * defaults to the media folder the Nextcloud `/Media` external mount is bound to,
 * so "Storage (Nextcloud)" grants exactly that folder read-write.
 */
import "server-only";
import type { RoleId } from "@/lib/rbac";

/** The folder scope the Nextcloud `/Media` mount is bound to (see nas/access.ts). */
const MEDIA_STORAGE_SCOPE = process.env.NEXTCLOUD_MEDIA_STORAGE_SCOPE || "/nas/truenas/infraweaver/media";

/** A single role grant, before it is stamped with principal/id/time. */
export interface PresetGrant {
  roleId: RoleId;
  scope: string;
}

export interface AccessPreset {
  id: string;
  label: string;
  description: string;
  grants: PresetGrant[];
  /**
   * Admin-tier app access (e.g. a Jellyfin administrator). Granting it on an
   * invite confers elevated privileges inside the app, so the invite route
   * gates these behind rbac:admin the same way arbitrary group grants are.
   */
  privileged?: boolean;
}

const JELLYFIN_SCOPE = "/jellyfin";
const JELLYFIN_GRANT: PresetGrant = { roleId: "jellyfin-user", scope: JELLYFIN_SCOPE };
const STORAGE_GRANT: PresetGrant = { roleId: "storage-contributor", scope: MEDIA_STORAGE_SCOPE };

/**
 * The presets offered on an invite. The invite UI drills app → role into the
 * per-app/per-role ids below; the legacy union ids (`all`/`jellyfin`/`storage`)
 * are kept so older invite links and any client still on the old shape keep
 * resolving. A preset is grantable by any inviter (users:write) unless it is
 * `privileged`, which additionally requires rbac:admin.
 */
export const ACCESS_PRESETS: readonly AccessPreset[] = [
  // Jellyfin — pick a role.
  { id: "jellyfin-user", label: "Jellyfin · User", description: "Stream media", grants: [{ roleId: "jellyfin-user", scope: JELLYFIN_SCOPE }] },
  { id: "jellyfin-admin", label: "Jellyfin · Admin", description: "Manage the Jellyfin server", grants: [{ roleId: "jellyfin-admin", scope: JELLYFIN_SCOPE }], privileged: true },
  // Nextcloud storage — pick an access level.
  { id: "storage-viewer", label: "Nextcloud · Read-only", description: "View the /Media folder", grants: [{ roleId: "storage-viewer", scope: MEDIA_STORAGE_SCOPE }] },
  { id: "storage-contributor", label: "Nextcloud · Read-write", description: "Upload to the /Media folder", grants: [{ roleId: "storage-contributor", scope: MEDIA_STORAGE_SCOPE }] },
  // Legacy union ids — explicit (not computed) so labels/order stay stable.
  { id: "all", label: "All apps", description: "Jellyfin + Nextcloud storage", grants: [JELLYFIN_GRANT, STORAGE_GRANT] },
  { id: "jellyfin", label: "Jellyfin", description: "Media streaming account", grants: [JELLYFIN_GRANT] },
  { id: "storage", label: "Storage (Nextcloud)", description: "Nextcloud /Media read-write", grants: [STORAGE_GRANT] },
] as const;

const PRESET_BY_ID = new Map(ACCESS_PRESETS.map((p) => [p.id, p]));

/** True if `id` is a known preset. */
export function isAccessPresetId(id: string): boolean {
  return PRESET_BY_ID.has(id);
}

/** True if `id` is a known preset that requires rbac:admin to grant. */
export function isPrivilegedPresetId(id: string): boolean {
  return PRESET_BY_ID.get(id)?.privileged === true;
}

/**
 * Expand preset ids to a deduplicated list of role grants. A grant is unique by
 * `roleId@scope`, so choosing `all` alongside `jellyfin` never doubles the
 * Jellyfin grant.
 */
export function expandPresetGrants(ids: readonly string[]): PresetGrant[] {
  const seen = new Set<string>();
  const out: PresetGrant[] = [];
  for (const id of ids) {
    const preset = PRESET_BY_ID.get(id);
    if (!preset) continue;
    for (const grant of preset.grants) {
      const key = `${grant.roleId}@${grant.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(grant);
    }
  }
  return out;
}
