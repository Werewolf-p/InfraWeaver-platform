import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findUserByEmail, authentikFetch } from "@/lib/authentik";

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { newEmail } = await req.json() as { newEmail: string };
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ email: newEmail }),
  });
  if (!r.ok) return NextResponse.json({ error: "Update failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
