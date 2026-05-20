import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findUserByEmail } from "@/lib/authentik";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);

  return NextResponse.json({
    name: user?.name ?? session.user?.name ?? "",
    email: user?.email ?? email,
    groups: user?.groups_obj?.map((g: { name: string }) => g.name) ?? [],
  });
}
