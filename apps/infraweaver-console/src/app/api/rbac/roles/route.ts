import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { BUILT_IN_ROLES } from "@/lib/rbac";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // All authenticated users can see role definitions (like Azure portal shows built-in roles)
  return NextResponse.json({ roles: BUILT_IN_ROLES });
}
