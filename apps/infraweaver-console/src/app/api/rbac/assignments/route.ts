import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission, BUILT_IN_ROLES, type RoleAssignment } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO  = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const USERS_FILE   = "users.yaml";

async function getFile() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }, cache: "no-store" }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<{ content: string; sha: string }>;
}

async function parseUsers(file: { content: string }) {
  const { load } = await import("js-yaml");
  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const parsed = load(content) as { users?: Record<string, Record<string, unknown>> };
  return parsed?.users ?? {};
}

async function saveUsers(users: Record<string, Record<string, unknown>>, sha: string, message: string) {
  const { dump } = await import("js-yaml");
  const body = dump({ users }, { lineWidth: -1, indent: 2 });
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: Buffer.from(body).toString("base64"), sha, committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" } }),
    }
  );
  if (!res.ok) throw new Error(`GitHub PUT failed: ${await res.text()}`);
}

// GET /api/rbac/assignments — list all role assignments across all users
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const file = await getFile();
    const users = await parseUsers(file);
    const assignments: Array<RoleAssignment & { username: string; userEmail: string; userName: string }> = [];
    for (const [username, data] of Object.entries(users)) {
      const ras = (data.role_assignments as RoleAssignment[] | undefined) ?? [];
      for (const ra of ras) {
        assignments.push({
          ...ra,
          username,
          userEmail: (data.email as string) ?? "",
          userName:  (data.name as string)  ?? username,
        });
      }
    }
    return NextResponse.json({ assignments });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST /api/rbac/assignments — add a role assignment
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:write")) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });

  const body = await req.json() as { username: string; roleId: string; scope: string };
  const { username, roleId, scope } = body;
  if (!username || !roleId || !scope) return NextResponse.json({ error: "username, roleId, scope required" }, { status: 400 });
  if (!BUILT_IN_ROLES.find(r => r.id === roleId)) return NextResponse.json({ error: "Unknown role" }, { status: 400 });

  try {
    const file = await getFile();
    const users = await parseUsers(file);
    if (!users[username]) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const existing = (users[username].role_assignments as RoleAssignment[] | undefined) ?? [];
    // Prevent duplicate
    if (existing.some(a => a.roleId === roleId && a.scope === scope)) {
      return NextResponse.json({ error: "Assignment already exists" }, { status: 409 });
    }
    const newAssignment: RoleAssignment = {
      id: randomUUID(),
      roleId,
      scope,
      grantedBy: session.user?.email ?? "unknown",
      grantedAt: new Date().toISOString(),
    };
    users[username].role_assignments = [...existing, newAssignment];
    await saveUsers(users, file.sha, `rbac: grant ${roleId} to ${username} at ${scope}`);
    await auditLog("rbac:assign", session.user?.email ?? "unknown", `Granted role '${roleId}' to '${username}' at scope '${scope}'`);
    return NextResponse.json({ ok: true, assignment: { ...newAssignment, username } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/rbac/assignments — remove by assignment id
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:write")) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });

  const { id, username } = await req.json() as { id: string; username: string };
  if (!id || !username) return NextResponse.json({ error: "id and username required" }, { status: 400 });

  try {
    const file = await getFile();
    const users = await parseUsers(file);
    if (!users[username]) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const before = (users[username].role_assignments as RoleAssignment[] | undefined) ?? [];
    const after = before.filter(a => a.id !== id);
    if (before.length === after.length) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    users[username].role_assignments = after;
    await saveUsers(users, file.sha, `rbac: revoke assignment ${id} from ${username}`);
    await auditLog("rbac:revoke", session.user?.email ?? "unknown", `Revoked assignment '${id}' from '${username}'`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
