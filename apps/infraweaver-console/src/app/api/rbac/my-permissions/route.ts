import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole, BUILT_IN_ROLES, type RoleAssignment } from "@/lib/rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO  = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

async function getUserAssignments(email: string): Promise<RoleAssignment[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/users.yaml`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }, cache: "no-store" }
    );
    if (!res.ok) return [];
    const file = await res.json();
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const { load } = await import("js-yaml");
    const parsed = load(content) as { users?: Record<string, { email?: string; role_assignments?: RoleAssignment[] }> };
    const users = parsed?.users ?? {};
    const match = Object.values(users).find(u => u.email === email);
    return match?.role_assignments ?? [];
  } catch { return []; }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  const email = session.user?.email ?? "";
  const legacyRole = getRole(groups);
  const assignments = await getUserAssignments(email);

  // Collect effective permissions from legacy role + assignments
  const perms = new Set<string>();
  if (legacyRole === "admin") {
    perms.add("*");
  } else {
    // Legacy operator/viewer permissions
    if (legacyRole === "operator") ["apps:read","apps:sync","config:read","catalog:write","users:read"].forEach(p => perms.add(p));
    if (legacyRole === "viewer")   ["apps:read","config:read","users:read"].forEach(p => perms.add(p));
  }
  for (const a of assignments) {
    const role = BUILT_IN_ROLES.find(r => r.id === a.roleId);
    if (role) role.permissions.forEach(p => perms.add(p));
  }

  return NextResponse.json({
    email,
    legacyRole,
    assignments,
    permissions: [...perms],
    isAdmin: legacyRole === "admin" || perms.has("*"),
  });
}
