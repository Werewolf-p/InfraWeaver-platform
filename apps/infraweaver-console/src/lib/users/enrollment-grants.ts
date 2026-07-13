/**
 * Enrollment-grant bridge — SERVER ONLY.
 *
 * An invite can carry access presets the operator chose ("Jellyfin", "Storage").
 * At invite time the invitee's USERNAME is not yet known (they pick it during
 * enrollment), so the grants cannot be written to users.yaml then. Instead the
 * invite stashes them on the Authentik invitation's `fixed_data.iw_roles`, which
 * the enrollment flow's user-write stage persists onto the new account as
 * `attributes.iw_roles`.
 *
 * This bridge closes the loop: on each reconcile tick it finds enrolled accounts
 * carrying that attribute, materializes the grants into users.yaml keyed by the
 * account's ACTUAL username, and clears the attribute so it is consumed exactly
 * once. The normal reconcile convergence that runs right after then provisions
 * Jellyfin / Nextcloud from those grants — so an invite with presets becomes a
 * fully working account with zero manual steps, regardless of the username chosen.
 *
 * Best-effort and idempotent: a re-run after the attribute is cleared finds
 * nothing; a grant already present in users.yaml is not duplicated; later operator
 * edits win because the one-shot attribute is gone.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { authentikFetch } from "@/lib/authentik";
import { loadUsersConfig, saveUsersConfig, type UsersConfigUser } from "@/lib/users-config";
import { auditLog } from "@/lib/audit-log";
import { errorMessage } from "@/lib/utils";
import type { RoleAssignment, RoleId } from "@/lib/rbac";

interface AkUser {
  pk: number;
  username: string;
  name?: string;
  email?: string;
  attributes?: Record<string, unknown>;
}

/** Read a well-formed `iw_roles` marker off an account's attributes; [] otherwise. */
function parseIwRoles(attributes: Record<string, unknown> | undefined): Array<{ roleId: string; scope: string }> {
  const raw = attributes?.iw_roles;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is { roleId: string; scope: string } =>
      !!g && typeof g === "object" && typeof (g as { roleId?: unknown }).roleId === "string" && typeof (g as { scope?: unknown }).scope === "string",
    )
    .map((g) => ({ roleId: g.roleId, scope: g.scope }));
}

/**
 * Materialize any pending enrollment grants into users.yaml and clear their
 * markers. Returns the usernames touched (for the reconcile summary). Never
 * throws — a failure here must not abort the reconcile that calls it.
 *
 * NOTE: lists up to 100 accounts (ample for this deployment). A larger directory
 * would need pagination; log-and-move-on rather than silently capping is the
 * follow-up if that ever bites.
 */
export async function bridgeEnrollmentGrants(): Promise<string[]> {
  let accounts: AkUser[];
  try {
    const r = await authentikFetch(`/core/users/?page_size=100`);
    if (!r.ok) return [];
    accounts = ((await r.json()) as { results?: AkUser[] }).results ?? [];
  } catch {
    return [];
  }

  const pending = accounts
    .map((account) => ({ account, grants: parseIwRoles(account.attributes) }))
    .filter((entry) => entry.grants.length > 0);
  if (pending.length === 0) return [];

  const cfg = await loadUsersConfig();
  const users: Record<string, UsersConfigUser> = { ...cfg.users };
  const nowIso = new Date().toISOString();
  const seeded: string[] = [];
  let changed = false;

  for (const { account, grants } of pending) {
    const username = account.username;
    const existing = users[username];
    const row: UsersConfigUser = existing ? { ...existing } : { name: account.name || username, email: account.email || "" };
    const current: RoleAssignment[] = Array.isArray(row.role_assignments) ? [...row.role_assignments] : [];
    const have = new Set(current.map((a) => `${a.roleId}@${a.scope}`));

    let added = 0;
    for (const grant of grants) {
      const key = `${grant.roleId}@${grant.scope}`;
      if (have.has(key)) continue;
      have.add(key);
      current.push({
        id: randomUUID(),
        roleId: grant.roleId as RoleId,
        scope: grant.scope,
        principalType: "user",
        principalId: username,
        grantedBy: "enrollment",
        grantedAt: nowIso,
      });
      added++;
    }

    if (!existing || added > 0) {
      row.role_assignments = current;
      if (!row.email && account.email) row.email = account.email;
      users[username] = row;
      changed = true;
    }
    seeded.push(username);
  }

  if (changed) {
    try {
      await saveUsersConfig(users, cfg.sha, `chore: seed enrollment grants for ${seeded.join(", ")}`, cfg.groups);
    } catch (e) {
      await auditLog("users:enrollment-grants", "infraweaver", `Failed to seed enrollment grants: ${errorMessage(e)}`, {
        result: "failure",
      }).catch(() => {});
      return []; // do NOT clear the markers if the write failed — retry next tick
    }
  }

  // Consume the markers so the bridge is one-shot per enrollment. Best-effort: a
  // failed clear only means a harmless re-seed attempt next tick (idempotent).
  for (const { account } of pending) {
    try {
      const attributes = { ...(account.attributes ?? {}) };
      delete attributes.iw_roles;
      await authentikFetch(`/core/users/${account.pk}/`, { method: "PATCH", body: JSON.stringify({ attributes }) });
    } catch {
      // leave it; next tick reconciles again (no duplicate grant — dedup above)
    }
  }

  await auditLog("users:enrollment-grants", "infraweaver", `Seeded enrollment grants for: ${seeded.join(", ")}`, {
    result: "success",
  }).catch(() => {});
  return seeded;
}
