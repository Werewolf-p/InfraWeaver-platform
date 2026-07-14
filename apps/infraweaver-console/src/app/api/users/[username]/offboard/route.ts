import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { authentikFetch } from "@/lib/authentik";
import { resolveAuthentikIdentity, canonicalAppUsername } from "@/lib/users/resolve-identity";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig, type LoadedUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";
import { offboardJellyfinUser } from "@/lib/jellyfin/access";
import { deprovisionNextcloudUser } from "@/lib/nextcloud/deprovision";
import { openBaoAppAccountStore } from "@/lib/app-accounts/store";
import { NEXTCLOUD_APP_ID } from "@/lib/nextcloud/config";

interface OffboardStep {
  name: string;
  success: boolean;
  message: string;
}

export async function POST(
  req: NextRequest,
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

  // deleteIdentity=true is the "Delete" action: it HARD-DELETES the Authentik user
  // object (not just disables it) so nothing is left behind. Absent/false body =
  // classic offboard (disable + retain the disabled account for audit).
  let deleteIdentity = false;
  try {
    const body = await req.json();
    deleteIdentity = body?.deleteIdentity === true;
  } catch {
    // Empty/invalid body → default offboard (disable) semantics.
  }

  // Load the roster row up front. Its email lets us resolve the Authentik identity
  // by email when the username no longer matches (case drift, or a post-invite
  // rename) — without that fallback, disable/delete silently skips the SSO account
  // and the identity is orphaned. The same load (and its sha) is reused for the
  // users.yaml removal at the end, so this is one fetch, not two.
  let usersConfig: LoadedUsersConfig | null = null;
  try {
    usersConfig = await loadUsersConfig(0);
  } catch {
    // users.yaml unreadable — proceed without the email fallback; step 6 reports it.
  }
  const row = usersConfig?.users?.[username];

  // The Authentik user may legitimately NOT exist: a user invited but never enrolled,
  // or one with only local app accounts (Jellyfin/Nextcloud) and no SSO identity. That
  // must NOT abort the cleanup — otherwise those half-provisioned users can never be
  // removed and their local accounts leak forever. Treat a missing user as "no SSO
  // identity to tear down" and continue with app-account + config removal.
  //
  // Resolve by username first, then fall back to the roster email: a username/case
  // mismatch must not orphan the identity by making the username lookup miss a user
  // that plainly exists under a different email-matched record. The fallback lives in
  // resolveAuthentikIdentity so the same guard covers reconcile and is exercised by
  // the `sec-offboard-drift` runtime self-test in /api/test-suite.
  const user = await resolveAuthentikIdentity(username, row?.email);

  // Self-guard without depending on the Authentik record (which may be absent):
  // block deleting your own account by username, and by email when the record exists.
  const selfEmail = (session.user as { email?: string }).email ?? "";
  const isSelf =
    (access.username && access.username === username) ||
    (!!user && user.email === selfEmail);
  if (isSelf) {
    return NextResponse.json({ error: "Cannot offboard yourself" }, { status: 400 });
  }

  // The local app accounts (Jellyfin, Nextcloud) were created under the CANONICAL
  // Authentik username (reconcile provisions under identity.username), which on a
  // username/case drift or post-invite rename is NOT the route key we were called
  // with. Deprovisioning by the raw route key would then miss those accounts and
  // orphan the local login + its stored credential — the same drift class the SSO
  // teardown above already fixes via resolveAuthentikIdentity. Key the app-account
  // teardown off the same resolved identity; fall back to the route key only for a
  // local-only user (no SSO identity), the only name they could exist under.
  const appUsername = canonicalAppUsername(user, username);

  const steps: OffboardStep[] = [];

  if (!user) {
    // No SSO identity — record it and fall through to app-account + config cleanup.
    steps.push({
      name: "Authentik account",
      success: true,
      message: "No Authentik account found (invited but never enrolled, or local-only) — nothing to disable/delete",
    });
  } else {
    // Step 1: Revoke tokens.
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

    // Step 2: Remove from groups.
    // Use the user object's OWN `groups` (the authoritative pk array the user serializer
    // already returned) rather than a `?member_by_username=` group query — that filter is
    // likewise ignored by Authentik and returns an unrelated page of groups, so the old
    // code removed the user from groups they were never in and never from the ones they
    // were. Membership is read from the record fetched above; the disable/delete below
    // does not change it beforehand, so it is still accurate here.
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

    // Step 3: Final identity action. "Delete" HARD-DELETES the Authentik user so nothing
    // is left; plain offboard disables it and keeps the disabled record for audit. The
    // explicit token-revoke + group-strip above already ran as defense in depth.
    if (deleteIdentity) {
      try {
        const r = await authentikFetch(`/core/users/${user.pk}/`, { method: "DELETE" });
        steps.push({ name: "Delete Authentik account", success: r.ok, message: r.ok ? "Account deleted" : `HTTP ${r.status}` });
      } catch (e) {
        steps.push({ name: "Delete Authentik account", success: false, message: safeError(e) });
      }
    } else {
      try {
        const r = await authentikFetch(`/core/users/${user.pk}/`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: false }),
        });
        steps.push({ name: "Disable account", success: r.ok, message: r.ok ? "Account disabled" : `HTTP ${r.status}` });
      } catch (e) {
        steps.push({ name: "Disable account", success: false, message: safeError(e) });
      }
    }
  }

  // Step 4: Delete the Jellyfin local account + its OpenBao app-account record.
  // A reconcile only disables a revoked account; offboard deletes it outright and
  // clears the roster row + stored credential so no orphaned login or revealable
  // password outlives the user. Idempotent — no account is a clean no-op.
  try {
    const result = await offboardJellyfinUser(appUsername);
    steps.push({ name: "Delete Jellyfin account", success: true, message: result.message });
  } catch (e) {
    steps.push({ name: "Delete Jellyfin account", success: false, message: safeError(e) });
  }

  // Step 5: Delete the residual Nextcloud user row. Where an Authentik account existed,
  // access is already revoked by the disable/delete + group-strip above (Nextcloud is
  // SSO/group-driven); this removes the leftover DB record via the OCS API. It never
  // touches /Media (an external TrueNAS mount, not the user's home).
  try {
    const result = await deprovisionNextcloudUser(appUsername);
    // Also drop the stored Nextcloud local credential so no revealable password
    // outlives the user. The Jellyfin step (offboardJellyfinUser) already clears its
    // own OpenBao record; this makes Nextcloud symmetric — without it, a deleted
    // user's Nextcloud password lingered in OpenBao (observed on a real delete).
    // Best-effort: an orphaned credential is harmless and must not fail the step.
    try {
      await openBaoAppAccountStore.deleteCredential(NEXTCLOUD_APP_ID, appUsername);
    } catch {
      // swallowed — user + access already gone; a stray secret is cleaned on next audit
    }
    steps.push({ name: "Delete Nextcloud user", success: true, message: result.message });
  } catch (e) {
    steps.push({ name: "Delete Nextcloud user", success: false, message: safeError(e) });
  }

  // Step 6: Remove from users.yaml. Reuse the roster load from the top (one fetch,
  // consistent sha); re-load only if that initial load failed.
  try {
    const { users, sha } = usersConfig ?? (await loadUsersConfig(0));
    if (users[username]) {
      delete users[username];
      const verb = deleteIdentity ? "delete" : "offboard";
      await saveUsersConfig(users, sha, `chore: ${verb} user ${username}`);
      steps.push({ name: "Remove from users.yaml", success: true, message: "User removed from config" });
    } else {
      steps.push({ name: "Remove from users.yaml", success: true, message: "User not in config (skipped)" });
    }
  } catch (e) {
    steps.push({ name: "Remove from users.yaml", success: false, message: safeError(e) });
  }

  const action = deleteIdentity ? "users:delete" : "users:offboard";
  await auditLog(action, session.user?.email ?? "unknown", `${deleteIdentity ? "Deleted" : "Offboarded"} ${username}`);
  return NextResponse.json({ steps });
}
