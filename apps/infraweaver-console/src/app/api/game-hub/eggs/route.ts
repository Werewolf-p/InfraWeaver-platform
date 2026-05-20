import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { BUILT_IN_EGGS } from "@/lib/game-eggs";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ eggs: BUILT_IN_EGGS });
}
