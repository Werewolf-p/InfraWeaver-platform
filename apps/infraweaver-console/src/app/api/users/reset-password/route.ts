import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import crypto from "crypto";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function generatePassword(length = 16): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map((b) => CHARSET[b % CHARSET.length]).join("");
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { username } = await req.json() as { username: string };
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const password = generatePassword();
  const r = await authentikFetch(`/core/users/${user.pk}/set_password/`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    return NextResponse.json({ error: "Failed to reset password" }, { status: 502 });
  }

  await auditLog("users:reset-password", session.user?.email ?? "unknown", `Reset password for ${username}`);
  return NextResponse.json({ tempPassword: password });
}
