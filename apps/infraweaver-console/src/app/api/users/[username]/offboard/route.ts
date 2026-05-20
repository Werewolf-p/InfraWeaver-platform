import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";

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
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
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

  // Step 2: Revoke tokens
  try {
    const r = await authentikFetch(`/core/tokens/?user=${encodeURIComponent(username)}`);
    const data = await r.json();
    const tokens: Array<{ identifier: string }> = data.results ?? [];
    for (const token of tokens) {
      await authentikFetch(`/core/tokens/${token.identifier}/`, { method: "DELETE" });
    }
    steps.push({ name: "Revoke tokens", success: true, message: `Revoked ${tokens.length} token(s)` });
  } catch (e) {
    steps.push({ name: "Revoke tokens", success: false, message: safeError(e) });
  }

  // Step 3: Remove from groups
  try {
    const r = await authentikFetch(`/core/groups/?member_by_username=${encodeURIComponent(username)}`);
    const data = await r.json();
    const groups: Array<{ pk: string }> = data.results ?? [];
    for (const group of groups) {
      await authentikFetch(`/core/groups/${group.pk}/remove_user/`, {
        method: "POST",
        body: JSON.stringify({ pk: user.pk }),
      });
    }
    steps.push({ name: "Remove from groups", success: true, message: `Removed from ${groups.length} group(s)` });
  } catch (e) {
    steps.push({ name: "Remove from groups", success: false, message: safeError(e) });
  }

  // Step 4: Remove from users.yaml
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
