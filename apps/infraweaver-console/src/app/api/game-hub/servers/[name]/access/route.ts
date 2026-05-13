import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { gameHubScope, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { normalizeRoleAssignments, loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { resolveRoleDefinition, type RoleAssignment } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

const SAFE_USERNAME_RE = /^[\w.@+-]{1,150}$/;
const SERVER_ROLE_IDS = ["game-server-admin", "game-server-operator", "game-server-viewer"] as const;
const ServerRole = z.enum(SERVER_ROLE_IDS);
const CreateAccessBody = z.object({
  username: z.string().min(1),
  role: ServerRole,
});

interface InheritedAccessAssignment {
  user: string;
  role: string;
  scope: string;
  source: "platform" | "game-hub";
}

interface ServerAccessAssignment {
  user: string;
  role: string;
}

function normalizeRoleId(roleId: string) {
  return resolveRoleDefinition(roleId)?.id ?? roleId;
}

function canManageServerAccess(
  access: Awaited<ReturnType<typeof getGameHubAccessContext>>,
  serverName: string,
) {
  return hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", serverName);
}

function requireUsername(username: string) {
  return SAFE_USERNAME_RE.test(username);
}

function sortAccess<T extends { user: string; role: string }>(entries: T[]) {
  return entries.sort((left, right) => left.user.localeCompare(right.user) || left.role.localeCompare(right.role));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const file = await loadUsersConfig();
    const inherited: InheritedAccessAssignment[] = [];
    const serverAssignments: ServerAccessAssignment[] = [];
    const scope = gameHubScope(name);

    for (const [username, user] of Object.entries(file.users)) {
      for (const assignment of normalizeRoleAssignments(username, user.role_assignments)) {
        if (assignment.principalType !== "user") continue;
        if ((assignment.principalId ?? username) !== username) continue;

        const role = normalizeRoleId(assignment.roleId);
        if (assignment.scope === "/") {
          inherited.push({ user: username, role, scope: assignment.scope, source: "platform" });
        } else if (assignment.scope === "/game-hub/") {
          inherited.push({ user: username, role, scope: assignment.scope, source: "game-hub" });
        } else if (assignment.scope === scope) {
          serverAssignments.push({ user: username, role });
        }
      }
    }

    return NextResponse.json({
      inherited: sortAccess(inherited),
      serverAssignments: sortAccess(serverAssignments),
      availableUsers: Object.keys(file.users).sort((left, right) => left.localeCompare(right)),
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!canManageServerAccess(access, name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = CreateAccessBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  if (!requireUsername(result.data.username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  try {
    const file = await loadUsersConfig();
    const user = file.users[result.data.username];
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const scope = gameHubScope(name);
    const assignments = normalizeRoleAssignments(result.data.username, user.role_assignments);
    if (assignments.some((assignment) => assignment.scope === scope && normalizeRoleId(assignment.roleId) === result.data.role)) {
      return NextResponse.json({ error: "Assignment already exists" }, { status: 409 });
    }

    const assignment: RoleAssignment = {
      id: randomUUID(),
      roleId: result.data.role,
      scope,
      principalType: "user",
      principalId: result.data.username,
      grantedBy: session.user?.email ?? "unknown",
      grantedAt: new Date().toISOString(),
    };

    user.role_assignments = [...assignments, assignment];
    await saveUsersConfig(file.users, file.sha, `rbac: grant ${assignment.roleId} to ${result.data.username} at ${scope}`);
    await auditLog("rbac:assign", session.user?.email ?? "unknown", `Granted ${assignment.roleId} to ${result.data.username} at ${scope}`);
    return NextResponse.json({ ok: true, assignment });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!canManageServerAccess(access, name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const username = req.nextUrl.searchParams.get("username") ?? "";
  const roleResult = ServerRole.safeParse(req.nextUrl.searchParams.get("role"));
  if (!requireUsername(username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  if (!roleResult.success) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  try {
    const file = await loadUsersConfig();
    const user = file.users[username];
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const scope = gameHubScope(name);
    const assignments = normalizeRoleAssignments(username, user.role_assignments);
    const nextAssignments = assignments.filter((assignment) => {
      if (assignment.scope !== scope) return true;
      if (assignment.principalType !== "user") return true;
      if ((assignment.principalId ?? username) !== username) return true;
      return normalizeRoleId(assignment.roleId) !== roleResult.data;
    });

    if (assignments.length === nextAssignments.length) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    user.role_assignments = nextAssignments;
    await saveUsersConfig(file.users, file.sha, `rbac: revoke ${roleResult.data} from ${username} at ${scope}`);
    await auditLog("rbac:revoke", session.user?.email ?? "unknown", `Revoked ${roleResult.data} from ${username} at ${scope}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
