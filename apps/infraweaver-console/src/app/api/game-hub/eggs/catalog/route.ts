import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPelicanCatalog } from "@/lib/pelican-eggs";
import { safeError } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await getPelicanCatalog());
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
