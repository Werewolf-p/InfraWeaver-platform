import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";
import { offboardJellyfinUser } from "@/lib/jellyfin/access";
import { deprovisionNextcloudUser } from "@/lib/nextcloud/deprovision";

interface OffboardStep {
  name: string;
  success: boolean;
  message: string;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  // users:invite is deliberately excluded: it is the low-privilege enrollment
  // role (C3/C4 hardening) and must never authorize destructive lifecycle actions.
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const selfEmail = (session.user as { email?: string }).email ?? "";
  if (user.email === selfEmail) {
    return NextResponse.json({ error: "Cannot offboard yourself" }, { status: 400 });
  }

  const steps: OffboardStep[] = [];

  // Step 1: Disable account
  try {
    const r = await authentikFetch(`/core/users/${user.pk}/`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: false }),
    });
    steps.push({ name: "Disable account", success: r.ok, message: r.ok ? "Account disabled" : `HTTP ${r.status}` });
  } catch (e) {
    steps.push({ name: "Disable account", success: false, message: safeError(e) });
  }

  // Step 2: Revoke tokens.
  // The token list MUST be scoped by `user__username` — NOT `user=<username>`.
  // Authentik silently IGNORES an unrecognized query filter and returns EVERY token
  // in the system, so `?user=<username>` (a string where the ignored `user` filter
  // wants a pk) once returned all tokens and this loop deleted the console's own
  // admin token and the embedded outpost's API token — a self-inflicted outage.
  // Defense in depth: even with the correct filter, only delete a token whose owner
  // is actually this user, and count only deletes that succeeded.
  try {
    const r = await authentikFetch(`/core/tokens/?user__username=${encodeURIComponent(username)}`);
    if (!r.ok) throw new Error(`List tokens: HTTP ${r.status}`);
    const data = await r.json();
    const tokens: Array<{ identifier: string; user?: number }> = data.results ?? [];
    let revoked = 0;
    for (const token of tokens) {
      if (token.user !== user.pk) continue; // never touch another principal's token
      const del = await authentikFetch(`/core/tokens/${encodeURIComponent(token.identifier)}/`, { method: "DELETE" });
      if (del.ok) revoked++;
    }
    steps.push({ name: "Revoke tokens", success: true, message: `Revoked ${revoked} token(s)` });
  } catch (e) {
    steps.push({ name: "Revoke tokens", success: false, message: safeError(e) });
  }

  // Step 3: Remove from groups.
  // Use the user object's OWN `groups` (the authoritative pk array the user serializer
  // already returned) rather than a `?member_by_username=` group query — that filter is
  // likewise ignored by Authentik and returns an unrelated page of groups, so the old
  // code removed the user from groups they were never in and never from the ones they
  // were. `groups` was captured before Step 1 disabled the account; disabling does not
  // change membership, so it is still accurate here.
  try {
    const groupPks: string[] = Array.isArray(user.groups)
      ? user.groups.filter((pk: unknown): pk is string => typeof pk === "string")
      : [];
    let removed = 0;
    for (const groupPk of groupPks) {
      const resp = await authentikFetch(`/core/groups/${encodeURIComponent(groupPk)}/remove_user/`, {
        method: "POST",
        body: JSON.stringify({ pk: user.pk }),
      });
      if (resp.ok) removed++;
    }
    steps.push({ name: "Remove from groups", success: true, message: `Removed from ${removed} group(s)` });
  } catch (e) {
    steps.push({ name: "Remove from groups", success: false, message: safeError(e) });
  }

  // Step 4: Delete the Jellyfin local account + its OpenBao app-account record.
  // A reconcile only disables a revoked account; offboard deletes it outright and
  // clears the roster row + stored credential so no orphaned login or revealable
  // password outlives the user. Idempotent — no account is a clean no-op.
  try {
    const result = await offboardJellyfinUser(username);
    steps.push({ name: "Delete Jellyfin account", success: true, message: result.message });
  } catch (e) {
    steps.push({ name: "Delete Jellyfin account", success: false, message: safeError(e) });
  }

  // Step 5: Delete the residual Nextcloud user row. Access is already revoked by the
  // Authentik disable + group-strip above (Nextcloud is SSO/group-driven); this removes
  // the leftover DB record via the OCS API. It never touches /Media (an external
  // TrueNAS mount, not the user's home).
  try {
    const result = await deprovisionNextcloudUser(username);
    steps.push({ name: "Delete Nextcloud user", success: true, message: result.message });
  } catch (e) {
    steps.push({ name: "Delete Nextcloud user", success: false, message: safeError(e) });
  }

  // Step 6: Remove from users.yaml
  try {
    const { users, sha } = await loadUsersConfig();
    if (users[username]) {
      delete users[username];
      await saveUsersConfig(users, sha, `chore: offboard user ${username}`);
      steps.push({ name: "Remove from users.yaml", success: true, message: "User removed from config" });
    } else {
      steps.push({ name: "Remove from users.yaml", success: true, message: "User not in config (skipped)" });
    }
  } catch (e) {
    steps.push({ name: "Remove from users.yaml", success: false, message: safeError(e) });
  }

  await auditLog("users:offboard", session.user?.email ?? "unknown", `Offboarded ${username}`);
  return NextResponse.json({ steps });
}
